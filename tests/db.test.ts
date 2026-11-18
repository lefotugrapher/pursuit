// Foundation tests: db (every table + stats), settings merge, time helpers, env parser, config, paths.
// Uses a temp DB and temp config dir; never touches data/ or config/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-db-test-'));
let dbCounter = 0;

const dbm = await import('../src/lib/db');
const time = await import('../src/lib/time');
const { parseEnvFile, redactSecrets } = await import('../src/lib/env');
const config = await import('../src/lib/config');
const paths = await import('../src/lib/paths');
const { log, makeLogger } = await import('../src/lib/log');
const { DEFAULT_SETTINGS } = await import('../src/lib/types');
type NewJob = import('../src/lib/types').NewJob;

function freshDb(): void {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `t${++dbCounter}.db`);
}

function newJob(over: Partial<NewJob> = {}): NewJob {
  return {
    id: 'job0000000000001',
    source: 'greenhouse',
    sourceId: 'gh-1',
    company: 'Acme Comms',
    title: 'PR Executive',
    location: 'Dublin, Ireland',
    country: 'IE',
    remote: false,
    url: 'https://boards.example.test/acme/1',
    applyUrl: 'https://boards.example.test/acme/1',
    ats: 'greenhouse',
    atsMeta: { boardToken: 'acme' },
    description: 'Short JD',
    ...over,
  };
}

beforeEach(freshDb);
after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('connection + migrations', () => {
  test('applies schema, WAL, foreign keys', () => {
    const d = dbm.db();
    assert.equal(dbm.schemaVersion(), dbm.SCHEMA_VERSION);
    assert.equal(String(d.prepare('PRAGMA journal_mode').get()?.journal_mode), 'wal');
    assert.equal(Number(d.prepare('PRAGMA foreign_keys').get()?.foreign_keys), 1);
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => String(r.name));
    for (const t of ['jobs', 'artifacts', 'applications', 'contacts', 'messages', 'inbox', 'events', 'runs', 'settings', 'llm_usage', 'kv', 'applied_jobs']) {
      assert.ok(tables.includes(t), `missing ${t}`);
    }
  });

  test('reopening an existing DB does not re-run migrations', () => {
    dbm.db();
    dbm.closeDb();
    assert.equal(dbm.schemaVersion(), dbm.SCHEMA_VERSION);
    const rows = dbm.db().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
    assert.equal(Number(rows?.n), dbm.SCHEMA_VERSION);
  });

  test('tx rolls back on error and supports nesting', () => {
    dbm.upsertJob(newJob());
    assert.throws(() =>
      dbm.tx(() => {
        dbm.updateJob('job0000000000001', { notes: 'inside' });
        throw new Error('boom');
      }),
    );
    assert.equal(dbm.getJob('job0000000000001')?.notes, undefined);
    dbm.tx(() => {
      dbm.updateJob('job0000000000001', { notes: 'outer' });
      assert.throws(() => dbm.tx(() => { dbm.updateJob('job0000000000001', { notes: 'inner' }); throw new Error('x'); }));
    });
    assert.equal(dbm.getJob('job0000000000001')?.notes, 'outer');
  });
});

describe('jobs', () => {
  test('upsert creates as discovered and logs a status event', () => {
    const { job, created } = dbm.upsertJob(newJob());
    assert.equal(created, true);
    assert.equal(job.status, 'discovered');
    assert.equal(job.remote, false);
    assert.equal(job.starred, false);
    assert.deepEqual(job.atsMeta, { boardToken: 'acme' });
    assert.ok(job.discoveredAt && job.updatedAt);
    const ev = dbm.listEvents({ jobId: job.id, type: dbm.STATUS_EVENT });
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].detail, { from: null, to: 'discovered', detail: { source: 'greenhouse' } });
  });

  test('upsert merges richer fields and never changes status', () => {
    dbm.upsertJob(newJob());
    dbm.setStatus('job0000000000001', 'scored');
    const richer = newJob({
      source: 'linkedin_guest',
      description: 'A much longer and richer job description with responsibilities and requirements.',
      applyUrl: 'https://boards.example.test/acme/1/apply',
      salary: { min: 36000, max: 42000, currency: 'EUR', period: 'year' },
      postedAt: '2026-11-10',
      atsMeta: { boardToken: 'other', questions: [{ id: 'q1' }] },
      department: 'Communications',
      remote: true,
    });
    const { job, created } = dbm.upsertJob(richer);
    assert.equal(created, false);
    assert.equal(job.status, 'scored');
    assert.equal(job.source, 'greenhouse', 'first-seen source kept');
    assert.equal(job.description, richer.description);
    assert.equal(job.applyUrl, 'https://boards.example.test/acme/1/apply');
    assert.deepEqual(job.salary, { min: 36000, max: 42000, currency: 'EUR', period: 'year' });
    assert.equal(job.postedAt, '2026-11-10T00:00:00.000Z');
    assert.equal(job.department, 'Communications');
    assert.equal(job.remote, true);
    // another source only adds missing meta keys
    assert.deepEqual(job.atsMeta, { boardToken: 'acme', questions: [{ id: 'q1' }] });

    const poorer = dbm.upsertJob(newJob({ description: 'tiny', salary: { raw: 'competitive' }, applyUrl: 'https://boards.example.test/acme/1' }));
    assert.equal(poorer.job.description, richer.description);
    assert.equal(poorer.job.applyUrl, 'https://boards.example.test/acme/1/apply');
    assert.equal(poorer.job.salary?.min, 36000);
    assert.equal(poorer.job.status, 'scored');
  });

  test('a better ATS upgrades ats + applyUrl', () => {
    dbm.upsertJob(newJob({ source: 'gmail_alert', ats: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1', applyUrl: '' }));
    assert.equal(dbm.getJob('job0000000000001')?.applyUrl, 'https://www.linkedin.com/jobs/view/1', 'applyUrl falls back to url');
    const { job } = dbm.upsertJob(newJob({ ats: 'greenhouse', applyUrl: 'https://boards.example.test/acme/1#app' }));
    assert.equal(job.ats, 'greenhouse');
    assert.equal(job.applyUrl, 'https://boards.example.test/acme/1#app');
    assert.equal(job.source, 'gmail_alert');
  });

  test('updateJob round-trips JSON columns and clears with undefined', () => {
    dbm.upsertJob(newJob());
    const detail = {
      total: 72, components: { skills: 0.8, roleFit: 0.7, seniority: 1, location: 1, freshness: 0.5, salary: 0.5 },
      reasons: ['PR match'], flags: [], llmUsed: false, scoredAt: '2026-11-15T10:00:00.000Z',
    };
    const filters = { pass: true, rejected: [], flags: ['NI right-to-work'] };
    const keywords = { keywords: [{ term: 'press releases', kind: 'duty' as const, weight: 1 }], matched: [], gaps: ['press releases'], pct: 0 };
    let job = dbm.updateJob('job0000000000001', { score: 72, scoreDetail: detail, filters, keywords, needs: ['captcha'], notes: 'n', starred: true });
    assert.ok(job);
    assert.equal(job.score, 72);
    assert.deepEqual(job.scoreDetail, detail);
    assert.deepEqual(job.filters, filters);
    assert.deepEqual(job.keywords, keywords);
    assert.deepEqual(job.needs, ['captcha']);
    assert.equal(job.starred, true);
    job = dbm.updateJob('job0000000000001', { notes: undefined, needs: undefined, title: undefined });
    assert.equal(job?.notes, undefined);
    assert.equal(job?.needs, undefined);
    assert.equal(job?.title, 'PR Executive', 'NOT NULL columns are never cleared');
    assert.equal(dbm.updateJob('missing', { notes: 'x' }), undefined);
    assert.throws(() => dbm.updateJob('job0000000000001', { status: 'bogus' as never }), /Unknown job status/);
  });

  test('setStatus writes {from,to,detail} events; countByStatus zero-fills', () => {
    dbm.upsertJob(newJob());
    const job = dbm.setStatus('job0000000000001', 'needs_you', 'captcha on form');
    assert.equal(job?.status, 'needs_you');
    const [latest] = dbm.listEvents({ jobId: 'job0000000000001', type: dbm.STATUS_EVENT, limit: 1 });
    assert.deepEqual(latest.detail, { from: 'discovered', to: 'needs_you', detail: 'captcha on form' });
    dbm.updateJob('job0000000000001', { status: 'applied' });
    const [viaUpdate] = dbm.listEvents({ jobId: 'job0000000000001', type: dbm.STATUS_EVENT, limit: 1 });
    assert.deepEqual(viaUpdate.detail, { from: 'needs_you', to: 'applied' });
    // unchanged status without detail is a no-op
    const before = dbm.listEvents({ jobId: 'job0000000000001' }).length;
    dbm.setStatus('job0000000000001', 'applied');
    assert.equal(dbm.listEvents({ jobId: 'job0000000000001' }).length, before);
    assert.throws(() => dbm.setStatus('job0000000000001', 'nope' as never));
    const counts = dbm.countByStatus();
    assert.equal(counts.applied, 1);
    assert.equal(counts.discovered, 0);
    assert.equal(Object.keys(counts).length, 16);
  });

  test('listJobs supports every JobQuery field', () => {
    const mk = (id: string, over: Partial<NewJob>) => dbm.upsertJob(newJob({ id, ...over }));
    mk('a', { company: 'Acme Comms', title: 'PR Executive', location: 'Dublin', source: 'greenhouse' });
    mk('b', { company: 'Beta Media', title: 'Content Writer', location: 'Belfast', source: 'lever' });
    mk('c', { company: 'Gamma 100% Social', title: 'Social_Media Exec', location: 'Remote, Ireland', source: 'lever', postedAt: '2026-11-01' });
    dbm.updateJob('a', { score: 80 });
    dbm.updateJob('b', { score: 55 });
    dbm.setStatus('b', 'scored');

    assert.deepEqual(dbm.listJobs({ status: 'scored' }).map((j) => j.id), ['b']);
    assert.deepEqual(dbm.listJobs({ status: ['scored', 'discovered'], orderBy: 'score' }).map((j) => j.id), ['a', 'b', 'c']);
    assert.deepEqual(dbm.listJobs({ status: [] }), []);
    assert.deepEqual(dbm.listJobs({ source: 'lever', orderBy: 'score', dir: 'asc' }).map((j) => j.id), ['b', 'c']);
    assert.deepEqual(dbm.listJobs({ minScore: 60 }).map((j) => j.id), ['a']);
    assert.deepEqual(dbm.listJobs({ search: 'BELFAST' }).map((j) => j.id), ['b']);
    assert.deepEqual(dbm.listJobs({ search: 'acme' }).map((j) => j.id), ['a']);
    assert.deepEqual(dbm.listJobs({ search: '100%' }).map((j) => j.id), ['c'], '% is literal');
    assert.deepEqual(dbm.listJobs({ search: 'l_m' }).map((j) => j.id), ['c'], 'literal underscore matches');
    assert.deepEqual(dbm.listJobs({ search: 'r_e' }), [], '_ is not a wildcard (would match "pr executive")');
    assert.deepEqual(dbm.listJobs({ company: 'beta media' }).map((j) => j.id), ['b']);
    assert.deepEqual(dbm.listJobs({ orderBy: 'postedAt' }).map((j) => j.id)[0], 'c');
    assert.equal(dbm.listJobs({ orderBy: 'score', limit: 1, offset: 1 })[0].id, 'b');
    assert.equal(dbm.countJobs({ source: 'lever' }), 2);
  });
});

describe('artifacts', () => {
  test('versions increment per job+kind; latest/list/get', () => {
    dbm.upsertJob(newJob());
    const a1 = dbm.addArtifact({ jobId: 'job0000000000001', kind: 'cv_pdf', path: '/tmp/a.pdf', meta: { pages: 1 } });
    const a2 = dbm.addArtifact({ jobId: 'job0000000000001', kind: 'cv_pdf', path: '/tmp/b.pdf' });
    const l1 = dbm.addArtifact({ jobId: 'job0000000000001', kind: 'cover_letter', content: 'Hello' });
    assert.equal(a1.version, 1);
    assert.equal(a2.version, 2);
    assert.equal(l1.version, 1);
    assert.deepEqual(a1.meta, { pages: 1 });
    assert.equal(dbm.latestArtifact('job0000000000001', 'cv_pdf')?.id, a2.id);
    assert.equal(dbm.latestArtifact('job0000000000001', 'prep'), undefined);
    assert.deepEqual(dbm.listArtifacts('job0000000000001', 'cv_pdf').map((a) => a.version), [2, 1]);
    assert.equal(dbm.listArtifacts('job0000000000001').length, 3);
    assert.equal(dbm.getArtifact(l1.id)?.content, 'Hello');
    assert.throws(() => dbm.addArtifact({ jobId: 'no-such-job', kind: 'prep', content: 'x' }), /FOREIGN KEY/);
  });
});

describe('applications', () => {
  test('add/update/list and applicationsToday', () => {
    dbm.upsertJob(newJob());
    const app = dbm.addApplication({ jobId: 'job0000000000001', method: 'auto', status: 'started', summaryVariant: 'pr' });
    assert.equal(app.status, 'started');
    assert.equal(app.submittedAt, undefined);
    assert.equal(dbm.applicationsToday(), 0);
    const done = dbm.updateApplication(app.id, { status: 'submitted', confirmation: 'Thanks for applying', screenshotPath: '/x.png' });
    assert.ok(done?.submittedAt);
    assert.equal(done?.confirmation, 'Thanks for applying');
    assert.equal(dbm.applicationsToday(), 1);
    assert.equal(dbm.applicationsToday('auto'), 1);
    assert.equal(dbm.applicationsToday('autopilot'), 0);
    assert.equal(dbm.listApplications({ jobId: 'job0000000000001' }).length, 1);
    assert.equal(dbm.listApplications({ status: ['needs_you'] }).length, 0);
    assert.equal(dbm.listApplications({ method: 'auto' })[0].summaryVariant, 'pr');
  });

  test('a job marked applied by hand counts once today', () => {
    dbm.upsertJob(newJob());
    dbm.setStatus('job0000000000001', 'applied', 'manual');
    dbm.addApplication({ jobId: 'job0000000000001', method: 'manual', status: 'submitted' });
    assert.equal(dbm.applicationsToday(), 1);
  });
});

describe('contacts', () => {
  test('upsert dedupes on email per job and merges', () => {
    dbm.upsertJob(newJob());
    const c1 = dbm.upsertContact({ jobId: 'job0000000000001', company: 'Acme', email: 'Talent@Acme.test', emailVerified: false, source: 'company_site', confidence: 0.4 });
    const c2 = dbm.upsertContact({ jobId: 'job0000000000001', company: 'Acme', email: 'talent@acme.test', name: 'Aoife', emailVerified: true, source: 'jd', confidence: 0.9 });
    assert.equal(c1.id, c2.id);
    assert.equal(c2.name, 'Aoife');
    assert.equal(c2.emailVerified, true);
    assert.equal(c2.confidence, 0.9);
    assert.equal(c2.source, 'company_site', 'first source kept');
    const other = dbm.upsertContact({ company: 'Acme', name: 'Recruiter search', linkedinUrl: 'https://www.linkedin.com/search/results/people/?keywords=acme', emailVerified: false, source: 'jd', confidence: 0.2 });
    assert.notEqual(other.id, c1.id);
    assert.equal(dbm.listContacts({ jobId: 'job0000000000001' }).length, 1);
    assert.equal(dbm.listContacts({ company: 'ACME' }).length, 2);
    assert.equal(dbm.listContacts({ hasEmail: false })[0].id, other.id);
    assert.equal(dbm.getContact(c1.id)?.email, 'Talent@Acme.test');
  });
});

describe('messages', () => {
  test('add/update/list and sentToday', () => {
    dbm.upsertJob(newJob());
    const m = dbm.addMessage({ jobId: 'job0000000000001', direction: 'out', channel: 'email', kind: 'outreach', to: 'a@acme.test', subject: 'Hi', body: 'Body', status: 'draft', guardProblems: [], slopHits: ['delve'] });
    assert.equal(m.attachCv, false);
    assert.deepEqual(m.slopHits, ['delve']);
    assert.equal(dbm.sentToday('email'), 0);
    const sent = dbm.updateMessage(m.id, { status: 'sent', messageId: '<abc@mail>' });
    assert.ok(sent?.sentAt);
    assert.equal(dbm.sentToday('email'), 1);
    assert.equal(dbm.sentToday('linkedin'), 0);
    dbm.addMessage({ direction: 'out', channel: 'email', kind: 'digest', to: 'me@self.test', body: 'digest', status: 'sent' });
    assert.equal(dbm.sentToday('email'), 1, 'digest to self does not count toward outreach cap');
    assert.equal(dbm.listMessages({ status: ['sent'], kind: 'outreach' }).length, 1);
    assert.equal(dbm.listMessages({ jobId: 'job0000000000001', channel: 'email' }).length, 1);
    assert.equal(dbm.getMessage(m.id)?.to, 'a@acme.test');
  });
});

describe('inbox', () => {
  test('dedupes on message id; list/update', () => {
    dbm.upsertJob(newJob());
    const base = { messageId: '<m1@acme>', from: 'Acme <jobs@acme.test>', fromAddress: 'jobs@acme.test', subject: 'Interview', date: '2026-11-14T09:00:00Z', body: 'We would like to   schedule\n an interview.' };
    const first = dbm.addInbox(base);
    assert.equal(first.created, true);
    assert.equal(first.item.snippet, 'We would like to schedule an interview.');
    assert.equal(first.item.handled, false);
    const dup = dbm.addInbox({ ...base, subject: 'changed' });
    assert.equal(dup.created, false);
    assert.equal(dup.item.id, first.item.id);
    assert.equal(dup.item.subject, 'Interview');
    const upd = dbm.updateInbox(first.item.id, { jobId: 'job0000000000001', kind: 'interview', confidence: 0.9, summary: 'Interview invite', handled: true });
    assert.equal(upd?.kind, 'interview');
    assert.equal(upd?.handled, true);
    assert.equal(dbm.listInbox({ jobId: 'job0000000000001', kind: ['interview'] }).length, 1);
    assert.equal(dbm.listInbox({ handled: false }).length, 0);
  });
});

describe('events, runs, kv, llm usage', () => {
  test('logEvent stores detail and redacts secret-looking keys', () => {
    const id = dbm.logEvent('test.thing', { password: 'hunter2hunter2', apiKey: 'k-123', token: 'acme-board', passed: 'yes', n: 1 });
    assert.ok(id > 0);
    const [ev] = dbm.listEvents({ type: 'test.thing' });
    assert.deepEqual(ev.detail, { password: '[redacted]', apiKey: '[redacted]', token: 'acme-board', passed: 'yes', n: 1 });
    dbm.logEvent('test.scalar', 'just text');
    assert.deepEqual(dbm.listEvents({ typePrefix: 'test.s' })[0].detail, { value: 'just text' });
  });

  test('log.* writes log events', () => {
    log.warn('scope-a', 'something odd', { k: 1 });
    makeLogger('scope-b').error('bad', new Error('kaput'));
    const evs = dbm.listEvents({ typePrefix: 'log.' });
    assert.equal(evs.length, 2);
    assert.equal(evs[0].type, 'log.error');
    assert.equal((evs[0].detail?.detail as { message: string }).message, 'kaput');
    assert.deepEqual(evs[1].detail, { scope: 'scope-a', msg: 'something odd', detail: { k: 1 } });
  });

  test('runs lifecycle and abandonOpenRuns', () => {
    const r1 = dbm.startRun('discover');
    dbm.finishRun(r1, true, { found: 3 });
    const r2 = dbm.startRun('inbox');
    const [latest] = dbm.listRuns(1);
    assert.equal(latest.id, r2);
    assert.equal(latest.ok, undefined);
    const done = dbm.listRuns(10, 'discover')[0];
    assert.equal(done.ok, true);
    assert.deepEqual(done.stats, { found: 3 });
    assert.equal(dbm.latestRunByKind().length, 2);
    assert.equal(dbm.abandonOpenRuns(), 1);
    assert.equal(dbm.listRuns(1, 'inbox')[0].ok, false);
  });

  test('kv JSON round trip', () => {
    assert.equal(dbm.kvGet('imap.lastUid'), undefined);
    dbm.kvSet('imap.lastUid', 42);
    dbm.kvSet('obj', { a: [1, 2] });
    assert.equal(dbm.kvGet<number>('imap.lastUid'), 42);
    assert.deepEqual(dbm.kvGet('obj'), { a: [1, 2] });
    dbm.kvSet('imap.lastUid', 43);
    assert.equal(dbm.kvGet('imap.lastUid'), 43);
    dbm.kvDelete('obj');
    assert.equal(dbm.kvGet('obj'), undefined);
  });

  test('recordLLM + llmUsageSummary', () => {
    dbm.recordLLM({ purpose: 'score', model: 'm1', promptTokens: 100, completionTokens: 20, costUsd: 0.001, ok: true });
    dbm.recordLLM({ purpose: 'score', model: 'm1', promptTokens: 50, completionTokens: 0, ok: false });
    dbm.recordLLM({ purpose: 'letter', model: 'm2', promptTokens: 10, completionTokens: 300, ok: true, ts: '2020-01-01T00:00:00Z' });
    const s = dbm.llmUsageSummary('2026-01-01T00:00:00Z');
    assert.equal(s.calls, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.promptTokens, 150);
    assert.equal(s.completionTokens, 20);
    assert.equal(s.costUsd, 0.001);
    assert.deepEqual(s.byPurpose.map((p) => p.purpose), ['score']);
    assert.equal(dbm.llmUsageSummary('2019-01-01').calls, 3);
  });
});

describe('settings', () => {
  test('defaults when nothing stored', () => {
    assert.deepEqual(dbm.getSettings(), DEFAULT_SETTINGS);
    assert.equal(dbm.isPaused(), false);
  });

  test('deep merge keeps untouched nested defaults; arrays replace', () => {
    const s = dbm.updateSettings({ autopilot: { enabled: true, ats: ['lever'] }, quietHours: { start: '23:00' } });
    assert.equal(s.autopilot.enabled, true);
    assert.deepEqual(s.autopilot.ats, ['lever']);
    assert.equal(s.autopilot.minScore, 85);
    assert.equal(s.quietHours.end, '08:00');
    assert.equal(s.quietHours.start, '23:00');
    assert.deepEqual(dbm.getSettings(), s);
    assert.equal(dbm.listEvents({ type: 'settings.updated' }).length, 1);
  });

  test('invalid writes throw; corrupt stored values fall back to defaults', () => {
    assert.throws(() => dbm.updateSettings({ dailyApplyCap: -1 }), dbm.SettingsValidationError);
    assert.throws(() => dbm.updateSettings({ mode: 'yolo' as never }), dbm.SettingsValidationError);
    assert.throws(() => dbm.updateSettings({ quietHours: { start: '25:00' } }), dbm.SettingsValidationError);
    dbm.db().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('settings', ?, 'x')").run(
      JSON.stringify({ paused: true, minScore: 'high', mode: 'yolo', autopilot: { dailyCap: 5 }, extra: 1 }),
    );
    const s = dbm.getSettings();
    assert.equal(s.paused, true);
    assert.equal(s.minScore, 60);
    assert.equal(s.mode, 'review');
    assert.equal(s.autopilot.dailyCap, 5);
    assert.equal(s.autopilot.enabled, false);
    assert.equal('extra' in s, false);
  });
});

describe('stats', () => {
  function seed(): void {
    const mk = (id: string, over: Partial<NewJob> = {}) => dbm.upsertJob(newJob({ id, sourceId: id, ...over }));
    mk('j1', { source: 'greenhouse', ats: 'greenhouse' });
    mk('j2', { source: 'greenhouse', ats: 'greenhouse' });
    mk('j3', { source: 'lever', ats: 'lever' });
    mk('j4', { source: 'linkedin_guest', ats: 'linkedin' });
    mk('j5', { source: 'lever', ats: 'lever' }); // discovered only
    mk('j6', { source: 'lever', ats: 'lever' }); // scored, then skipped
    dbm.updateJob('j1', { score: 92 });
    dbm.updateJob('j2', { score: 75 });
    dbm.updateJob('j3', { score: 64 });
    dbm.updateJob('j4', { score: 50 });
    dbm.updateJob('j6', { score: 30, status: 'skipped' });

    for (const id of ['j1', 'j2', 'j3', 'j4']) {
      dbm.setStatus(id, 'scored');
      dbm.setStatus(id, 'ready');
      dbm.setStatus(id, 'approved');
    }
    // j1: submitted via runner, then interview
    dbm.addApplication({ jobId: 'j1', method: 'auto', status: 'submitted', summaryVariant: 'pr' });
    dbm.setStatus('j1', 'applied');
    dbm.setStatus('j1', 'interview');
    // j2: applied, linked rejection email
    dbm.addApplication({ jobId: 'j2', method: 'auto', status: 'submitted', summaryVariant: 'content' });
    dbm.setStatus('j2', 'applied');
    dbm.addInbox({ messageId: '<r@x>', from: 'x', fromAddress: 'x@x.test', subject: 'Update', date: '2026-11-15T10:00:00Z', body: 'Unfortunately', jobId: 'j2', kind: 'rejection' });
    // j3: applied, only a confirmation email (not a response)
    dbm.addApplication({ jobId: 'j3', method: 'autopilot', status: 'submitted', summaryVariant: 'pr' });
    dbm.setStatus('j3', 'applied');
    dbm.addInbox({ messageId: '<c@x>', from: 'x', fromAddress: 'x@x.test', subject: 'Thanks for applying', date: '2026-11-15T10:00:00Z', body: 'Received', jobId: 'j3', kind: 'confirmation' });
    // j4: marked applied by hand, then rejected
    dbm.setStatus('j4', 'applied', 'manual');
    dbm.setStatus('j4', 'rejected');
  }

  test('funnelStats', () => {
    seed();
    const f = dbm.funnelStats();
    assert.equal(f.discovered, 6);
    assert.equal(f.scored, 5);
    assert.equal(f.ready, 4);
    assert.equal(f.applied, 4);
    assert.equal(f.replied, 3); // j1 interview, j2 rejection email, j4 rejected
    assert.equal(f.interview, 1);
    assert.equal(f.offer, 0);
    assert.equal(f.rejected, 1);
    assert.equal(f.appliedToday, 4);
    assert.equal(f.appliedWeek, 4);
    assert.equal(f.responseRate, 0.75);
  });

  test('responseRates by dimension', () => {
    seed();
    const rows = dbm.responseRates();
    const pick = (dimension: string, key: string) => rows.find((r) => r.dimension === dimension && r.key === key);
    assert.deepEqual(pick('source', 'greenhouse'), { dimension: 'source', key: 'greenhouse', applied: 2, responded: 2, interviews: 1, rate: 1 });
    assert.deepEqual(pick('source', 'lever'), { dimension: 'source', key: 'lever', applied: 1, responded: 0, interviews: 0, rate: 0 });
    assert.equal(pick('ats', 'linkedin')?.responded, 1);
    assert.equal(pick('scoreBucket', '90+')?.interviews, 1);
    assert.equal(pick('scoreBucket', '70-79')?.applied, 1);
    assert.equal(pick('scoreBucket', '60-69')?.rate, 0);
    assert.equal(pick('scoreBucket', '45-59')?.applied, 1);
    assert.deepEqual(pick('summaryVariant', 'pr'), { dimension: 'summaryVariant', key: 'pr', applied: 2, responded: 1, interviews: 1, rate: 0.5 });
    assert.equal(pick('summaryVariant', 'unknown')?.applied, 1);
    const buckets = rows.filter((r) => r.dimension === 'scoreBucket').map((r) => r.key);
    assert.deepEqual(buckets, ['90+', '70-79', '60-69', '45-59']);
    assert.deepEqual([...new Set(rows.map((r) => r.dimension))], ['source', 'ats', 'scoreBucket', 'summaryVariant']);
  });

  test('dailyApplied zero-fills Dublin days, oldest first', () => {
    seed();
    const days = dbm.dailyApplied(7);
    assert.equal(days.length, 7);
    assert.equal(days[6].date, time.todayDublin());
    assert.equal(days[6].count, 4);
    assert.equal(days[0].count, 0);
    assert.equal(days[0].date, time.addDays(time.todayDublin(), -6));
  });

  test('empty DB stats are zero, not NaN', () => {
    const f = dbm.funnelStats();
    assert.equal(f.responseRate, 0);
    assert.deepEqual(dbm.responseRates(), []);
  });
});

describe('time', () => {
  test('Dublin dates around midnight and DST', () => {
    assert.equal(time.dublinDate(new Date('2026-07-01T23:30:00Z')), '2026-07-02'); // IST (UTC+1)
    assert.equal(time.dublinDate(new Date('2026-12-01T23:30:00Z')), '2026-12-01'); // GMT
    assert.equal(time.dublinMidnight('2026-07-02').toISOString(), '2026-07-01T23:00:00.000Z');
    assert.equal(time.dublinMidnight('2026-12-02').toISOString(), '2026-12-02T00:00:00.000Z');
    assert.equal(time.dublinMidnight('2026-03-29').toISOString(), '2026-03-29T00:00:00.000Z'); // DST starts 01:00 UTC
    assert.equal(time.dublinMidnight('2026-10-25').toISOString(), '2026-10-24T23:00:00.000Z'); // DST ends 01:00 UTC
    assert.equal(time.startOfDayDublin(new Date('2026-07-02T10:00:00Z')).toISOString(), '2026-07-01T23:00:00.000Z');
    assert.equal(time.dublinClock(new Date('2026-07-01T07:05:00Z')), '08:05');
    assert.equal(time.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(time.addDays('2026-03-01', -1), '2026-02-28');
  });

  test('isQuietHours handles wrap-around and empty windows', () => {
    const s = { quietHours: { start: '22:00', end: '08:00' } };
    assert.equal(time.isQuietHours(s, new Date('2026-12-01T23:00:00Z')), true);
    assert.equal(time.isQuietHours(s, new Date('2026-12-01T07:59:00Z')), true);
    assert.equal(time.isQuietHours(s, new Date('2026-12-01T08:00:00Z')), false);
    assert.equal(time.isQuietHours(s, new Date('2026-07-01T07:30:00Z')), false); // 08:30 IST
    assert.equal(time.isQuietHours(s, new Date('2026-07-01T21:00:00Z')), true); // 22:00 IST
    assert.equal(time.isQuietHours({ quietHours: { start: '13:00', end: '14:00' } }, new Date('2026-12-01T13:30:00Z')), true);
    assert.equal(time.isQuietHours({ quietHours: { start: '09:00', end: '09:00' } }, new Date()), false);
    assert.equal(time.isQuietHours({ quietHours: { start: 'bad', end: '08:00' } }, new Date()), false);
  });

  test('daysBetween and toIso', () => {
    assert.equal(time.daysBetween('2026-11-01T00:00:00Z', '2026-11-07T12:00:00Z'), 6.5);
    assert.ok(Number.isNaN(time.daysBetween('nope', new Date())));
    assert.equal(time.toIso('2026-11-10'), '2026-11-10T00:00:00.000Z');
    assert.equal(time.toIso('garbage'), undefined);
    assert.match(time.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('env + paths', () => {
  test('parseEnvFile handles comments, quotes, export', () => {
    const parsed = parseEnvFile([
      '# comment',
      'A=1',
      'export B="two words"',
      "C='single # not comment'",
      'D=value # trailing comment',
      'E=',
      'not a line',
      'F="line\\nbreak"',
    ].join('\n'));
    assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'single # not comment', D: 'value', E: '', F: 'line\nbreak' });
  });

  test('redactSecrets replaces configured secret values', () => {
    const prev = process.env.GMAIL_APP_PASSWORD;
    process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
    try {
      assert.equal(redactSecrets('pw=abcdefghijklmnop or abcd efgh ijkl mnop'), 'pw=[redacted] or [redacted]');
    } finally {
      if (prev === undefined) delete process.env.GMAIL_APP_PASSWORD;
      else process.env.GMAIL_APP_PASSWORD = prev;
    }
  });

  test('jobArtifactDir is traversal-safe', () => {
    assert.equal(paths.jobArtifactDir('abc123'), path.join(paths.ARTIFACTS_DIR, 'abc123'));
    assert.ok(paths.isInside(paths.ARTIFACTS_DIR, paths.jobArtifactDir('../../etc/passwd')));
    assert.throws(() => paths.jobArtifactDir('..'));
    assert.equal(paths.isInside('/a/b', '/a/b/c'), true);
    assert.equal(paths.isInside('/a/b', '/a/bc'), false);
  });
});

describe('config', () => {
  const cfgDir = path.join(TMP, 'config');
  const profile = {
    name: { first: 'Test', last: 'User', preferred: 'Tess', full: 'Test User' },
    email: 'test@example.test', phone: '000', location: 'Dundalk', links: {},
    targets: {
      roles: ['PR'], keywords: ['communications'], locations: ['dublin'], remoteOk: true,
      seniority: ['graduate'], maxYearsRequired: 2, salaryFloorEUR: 30000,
    },
    workAuth: { summary: 'n/a', needsSponsorship: null, confirm: true },
    coverLetter: { signOff: 'Kind Regards' },
  };

  beforeEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    process.env.PURSUIT_CONFIG_DIR = cfgDir;
  });
  afterEach(() => {
    delete process.env.PURSUIT_CONFIG_DIR;
  });

  test('falls back to example, applies defaults, then prefers the real file', () => {
    fs.writeFileSync(path.join(cfgDir, 'profile.example.json'), JSON.stringify(profile));
    const p = config.loadProfile();
    assert.equal(p.name.full, 'Test User');
    assert.deepEqual(p.targets.secondaryLocations, []);
    const saved = config.saveProfile({ ...p, phone: '111' });
    assert.equal(saved.phone, '111');
    assert.ok(fs.existsSync(path.join(cfgDir, 'profile.json')));
    assert.equal(config.loadProfile().phone, '111');
    assert.deepEqual(fs.readdirSync(cfgDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
  });

  test('clear errors for missing and invalid files; save refuses invalid data', () => {
    assert.throws(() => config.loadFacts(), /Missing config/);
    fs.writeFileSync(path.join(cfgDir, 'facts.json'), JSON.stringify({ version: 1, facts: [{ id: 'a', kind: 'role', text: 'x' }, { id: 'a', kind: 'role', text: 'y' }] }));
    assert.throws(() => config.loadFacts(), /Duplicate fact ids: a/);
    fs.writeFileSync(path.join(cfgDir, 'answers.json'), '{ not json');
    assert.throws(() => config.loadAnswers(), /Invalid JSON/);
    assert.throws(() => config.saveSources({ companies: [{ name: 'X', ats: 'bamboo' }] } as never), /Refusing to save/);
    const status = config.configStatus();
    assert.equal(status.find((s) => s.name === 'facts')?.valid, false);
    assert.equal(status.find((s) => s.name === 'sources')?.file, 'missing');
    assert.deepEqual(config.validateConfigJson('answers', '{"entries":[]}'), { ok: true });
  });

  test('loaded objects are copies (callers cannot mutate the cache)', () => {
    fs.writeFileSync(path.join(cfgDir, 'sources.json'), JSON.stringify({ companies: [] }));
    const s = config.loadSources();
    assert.equal(s.linkedinGuest.minIntervalMs, 3000);
    s.companies.push({ name: 'Mutant', ats: 'lever', token: 'm', enabled: true });
    assert.equal(config.loadSources().companies.length, 0);
  });
});
