// Pure-function tests for the dashboard API layer: request guard, artifact path-traversal guard,
// /api/status payload builder, manual status transitions and queue approval rules.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkGuard, hostnameOf, isAllowedHost, isAllowedOrigin, guardRequest } from '../src/app/api/_lib/guard';
import { resolveServablePath, servedTypeFor, inlineContentType, parseArtifactId, contentDisposition } from '../src/app/api/_lib/artifact';
import { buildStatusPayload, parseHeartbeat, heartbeatAgeSec, workerHealth } from '../src/app/api/_lib/status';
import { availableActions, canTransition, isManualAction, TRANSITIONS } from '../src/components/job/transitions';
import {
  applyAnswerEdit, approvalGate, batchEligible, blockingAnswers, jobFlags, letterFindings, parseAnswers, parseAtsReport, serializeAnswers,
} from '../src/components/queue/model';
import { JOB_STATUSES, DEFAULT_SETTINGS, type AnsweredQuestion, type Job, type JobStatus, type RunRow } from '../src/lib/types';

describe('request guard', () => {
  it('parses host headers', () => {
    assert.equal(hostnameOf('localhost:7020'), 'localhost');
    assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
    assert.equal(hostnameOf('[::1]:7020'), '::1');
    assert.equal(hostnameOf('LOCALHOST'), 'localhost');
    assert.equal(hostnameOf(''), null);
    assert.equal(hostnameOf(null), null);
  });

  it('allows only local hosts unless extended', () => {
    assert.ok(isAllowedHost('localhost:7020', ''));
    assert.ok(isAllowedHost('127.0.0.1:7020', ''));
    assert.ok(isAllowedHost('[::1]:7020', ''));
    assert.ok(!isAllowedHost('evil.example:7020', ''));
    assert.ok(!isAllowedHost('localhost.evil.example', ''));
    assert.ok(!isAllowedHost(null, ''));
    assert.ok(isAllowedHost('kayzee-mac.local:7020', 'kayzee-mac.local, 192.168.1.20'));
    assert.ok(isAllowedHost('192.168.1.20:7020', 'kayzee-mac.local, 192.168.1.20'));
  });

  it('checks origin for mutating requests', () => {
    assert.ok(isAllowedOrigin(null, ''));
    assert.ok(isAllowedOrigin('http://localhost:7020', ''));
    assert.ok(!isAllowedOrigin('https://evil.example', ''));
    assert.ok(!isAllowedOrigin('null', ''));
    assert.ok(!isAllowedOrigin('not a url', ''));
  });

  it('requires the CSRF header on mutating requests only', () => {
    const base = { host: 'localhost:7020', origin: 'http://localhost:7020' };
    assert.deepEqual(checkGuard({ ...base, csrf: null }, { mutating: false, extraHosts: '' }), { ok: true });
    assert.equal(checkGuard({ ...base, csrf: null }, { mutating: true, extraHosts: '' }).ok, false);
    assert.equal(checkGuard({ ...base, csrf: '0' }, { mutating: true, extraHosts: '' }).ok, false);
    assert.deepEqual(checkGuard({ ...base, csrf: '1' }, { mutating: true, extraHosts: '' }), { ok: true });
    assert.equal(checkGuard({ host: 'evil.example', origin: null, csrf: '1' }, { mutating: true, extraHosts: '' }).ok, false);
    assert.equal(checkGuard({ host: 'localhost', origin: 'https://evil.example', csrf: '1' }, { mutating: true, extraHosts: '' }).ok, false);
  });

  it('guardRequest returns a 403 response or null', async () => {
    const prev = process.env.PURSUIT_ALLOWED_HOSTS;
    delete process.env.PURSUIT_ALLOWED_HOSTS;
    try {
      const ok = new Request('http://localhost:7020/api/task/score', { method: 'POST', headers: { host: 'localhost:7020', 'x-pursuit': '1' } });
      assert.equal(guardRequest(ok, { mutating: true }), null);
      const bad = new Request('http://localhost:7020/api/task/score', { method: 'POST', headers: { host: 'localhost:7020' } });
      const res = guardRequest(bad, { mutating: true });
      assert.ok(res);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, false);
    } finally {
      if (prev !== undefined) process.env.PURSUIT_ALLOWED_HOSTS = prev;
    }
  });
});

describe('artifact path guard', () => {
  let tmp: string;
  let data: string;
  let artifacts: string;
  let screenshots: string;
  let outside: string;

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-api-')));
    data = path.join(tmp, 'data');
    artifacts = path.join(data, 'artifacts');
    screenshots = path.join(data, 'screenshots');
    outside = path.join(tmp, 'secret');
    fs.mkdirSync(path.join(artifacts, 'job1'), { recursive: true });
    fs.mkdirSync(screenshots, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'job1', 'cv.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(screenshots, 'shot.png'), 'png');
    fs.writeFileSync(path.join(outside, '.env.local'), 'OPENROUTER_API_KEY=nope');
    fs.writeFileSync(path.join(data, 'pursuit.db'), 'db');
    fs.symlinkSync(path.join(outside, '.env.local'), path.join(artifacts, 'job1', 'link.pdf'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const roots = () => [artifacts, screenshots];

  it('serves files inside the artifact and screenshot dirs', () => {
    assert.equal(resolveServablePath(path.join(artifacts, 'job1', 'cv.pdf'), roots(), { base: tmp }), path.join(artifacts, 'job1', 'cv.pdf'));
    assert.equal(resolveServablePath(path.join(screenshots, 'shot.png'), roots(), { base: tmp }), path.join(screenshots, 'shot.png'));
    assert.equal(resolveServablePath('data/artifacts/job1/cv.pdf', roots(), { base: tmp }), path.join(artifacts, 'job1', 'cv.pdf'));
  });

  it('rejects traversal, siblings, symlink escapes, roots themselves and junk', () => {
    assert.equal(resolveServablePath(path.join(artifacts, '..', '..', 'secret', '.env.local'), roots(), { base: tmp }), null);
    assert.equal(resolveServablePath('data/artifacts/../../secret/.env.local', roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(path.join(data, 'pursuit.db'), roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(path.join(artifacts, 'job1', 'link.pdf'), roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(artifacts, roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(path.join(artifacts, 'missing.pdf'), roots(), { base: tmp }), null);
    assert.equal(resolveServablePath('/etc/passwd', roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(`${artifacts}/job1/cv.pdf\0.png`, roots(), { base: tmp }), null);
    assert.equal(resolveServablePath('', roots(), { base: tmp }), null);
    assert.equal(resolveServablePath(undefined, roots(), { base: tmp }), null);
  });

  it('rejects a prefix-sharing sibling directory', () => {
    const sibling = path.join(data, 'artifacts-evil');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'x.pdf'), 'x');
    assert.equal(resolveServablePath(path.join(sibling, 'x.pdf'), roots(), { base: tmp }), null);
  });

  it('maps content types safely', () => {
    assert.deepEqual(servedTypeFor('a/b/CV.PDF'), { contentType: 'application/pdf', inline: true });
    assert.equal(servedTypeFor('x.png').contentType, 'image/png');
    assert.equal(servedTypeFor('x.tex').contentType, 'text/plain; charset=utf-8');
    assert.equal(servedTypeFor('x.html').contentType, 'text/plain; charset=utf-8');
    assert.deepEqual(servedTypeFor('x.exe'), { contentType: 'application/octet-stream', inline: false });
    assert.equal(inlineContentType({ kind: 'answers', content: '[]' }), 'application/json; charset=utf-8');
    assert.equal(inlineContentType({ kind: 'answers', content: 'nope' }), 'text/plain; charset=utf-8');
    assert.equal(inlineContentType({ kind: 'cover_letter', content: '{}' }), 'text/plain; charset=utf-8');
  });

  it('parses artifact ids strictly', () => {
    assert.equal(parseArtifactId('12'), 12);
    for (const bad of ['0', '-1', '1.5', 'abc', '../1', '', undefined, '1e3', '9999999999999']) assert.equal(parseArtifactId(bad), null, String(bad));
  });

  it('builds a safe content-disposition', () => {
    assert.equal(contentDisposition('/x/Kshitiz_Mittal_CV.pdf', true), `inline; filename="Kshitiz_Mittal_CV.pdf"; filename*=UTF-8''Kshitiz_Mittal_CV.pdf`);
    assert.match(contentDisposition('/x/a"b.pdf', false), /^attachment; filename="a_b.pdf"/);
  });
});

describe('status payload', () => {
  const now = new Date('2026-11-15T12:00:00.000Z');
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  counts.ready = 7;
  counts.needs_you = 2;
  counts.approved = 1;
  counts.applying = 1;
  counts.applied = 4;
  const runs: RunRow[] = [
    { id: 9, kind: 'score', startedAt: '2026-11-15T11:59:00.000Z' },
    { id: 8, kind: 'discover', startedAt: '2026-11-15T11:00:00.000Z', finishedAt: '2026-11-15T11:01:00.000Z', ok: true, stats: { found: 3 } },
    { id: 7, kind: 'inbox', startedAt: '2026-11-15T10:50:00.000Z', finishedAt: '2026-11-15T10:50:05.000Z', ok: false, error: 'x'.repeat(1000) },
  ];

  it('parses heartbeat formats', () => {
    assert.equal(parseHeartbeat('2026-11-15T11:59:30.000Z'), '2026-11-15T11:59:30.000Z');
    assert.equal(parseHeartbeat(Date.parse('2026-11-15T11:59:30.000Z')), '2026-11-15T11:59:30.000Z');
    assert.equal(parseHeartbeat(Date.parse('2026-11-15T11:59:30.000Z') / 1000), '2026-11-15T11:59:30.000Z');
    assert.equal(parseHeartbeat({ ts: '2026-11-15T11:59:30.000Z', pid: 42 }), '2026-11-15T11:59:30.000Z');
    assert.equal(parseHeartbeat({ pid: 42 }), null);
    assert.equal(parseHeartbeat('garbage'), null);
    assert.equal(parseHeartbeat(undefined), null);
  });

  it('computes heartbeat age and online state', () => {
    assert.equal(heartbeatAgeSec('2026-11-15T11:59:30.000Z', now), 30);
    assert.equal(heartbeatAgeSec(null, now), null);
    assert.equal(heartbeatAgeSec('2026-11-15T12:00:10.000Z', now), 0);
    assert.equal(workerHealth('2026-11-15T11:59:30.000Z', now).online, true);
    assert.equal(workerHealth('2026-11-15T11:58:00.000Z', now).online, false);
    assert.deepEqual(workerHealth(undefined, now), { heartbeatAt: null, ageSec: null, online: false });
  });

  it('builds the payload', () => {
    const p = buildStatusPayload({
      counts, settings: { ...DEFAULT_SETTINGS, paused: true }, heartbeat: { ts: '2026-11-15T11:59:50.000Z' }, runs, hasLLM: false, hasMail: true, now,
    });
    assert.equal(p.ok, true);
    assert.equal(p.now, now.toISOString());
    assert.equal(p.paused, true);
    assert.equal(p.mode, 'review');
    assert.equal(p.autopilot, false);
    assert.equal(p.queueSize, 7);
    assert.equal(p.needsYou, 2);
    assert.equal(p.inFlight, 2);
    assert.equal(p.total, 15);
    assert.deepEqual(p.worker, { heartbeatAt: '2026-11-15T11:59:50.000Z', ageSec: 10, online: true });
    assert.deepEqual(p.lastRuns.map((r) => r.state), ['running', 'ok', 'failed']);
    assert.ok((p.lastRuns[2].error ?? '').length <= 240);
    assert.deepEqual(p.integrations, { llm: false, mail: true });
  });

  it('caps runs and reports autopilot only when both switches are on', () => {
    const many: RunRow[] = Array.from({ length: 10 }, (_, i) => ({ id: i, kind: 'k', startedAt: now.toISOString(), finishedAt: now.toISOString(), ok: true }));
    const settings = { ...DEFAULT_SETTINGS, mode: 'autopilot' as const, autopilot: { ...DEFAULT_SETTINGS.autopilot, enabled: true } };
    const p = buildStatusPayload({ counts, settings, heartbeat: null, runs: many, hasLLM: true, hasMail: false, now });
    assert.equal(p.lastRuns.length, 6);
    assert.equal(p.autopilot, true);
    assert.equal(p.worker.online, false);
    const off = buildStatusPayload({ counts, settings: { ...settings, autopilot: { ...settings.autopilot, enabled: false } }, heartbeat: null, runs: [], hasLLM: true, hasMail: false, now });
    assert.equal(off.autopilot, false);
  });
});

describe('manual transitions', () => {
  it('only approves ready jobs', () => {
    assert.ok(canTransition('approve', 'ready'));
    for (const s of JOB_STATUSES.filter((s) => s !== 'ready')) assert.ok(!canTransition('approve', s), s);
  });
  it('lists sensible actions per status', () => {
    assert.deepEqual(availableActions('ready').sort(), ['approve', 'markApplied', 'skip', 'withdraw'].sort());
    assert.ok(availableActions('applied').includes('markInterview'));
    assert.ok(availableActions('needs_you').includes('markApplied'));
    assert.ok(availableActions('approved').includes('requeue'));
    assert.deepEqual(availableActions('withdrawn'), []);
  });
  it('every rule targets a different status than its sources', () => {
    for (const [name, rule] of Object.entries(TRANSITIONS)) assert.ok(!rule.from.includes(rule.to), name);
  });
  it('validates action names', () => {
    assert.ok(isManualAction('approve'));
    assert.ok(!isManualAction('toString'));
    assert.ok(!isManualAction('delete'));
  });
});

describe('queue rules', () => {
  const q = (over: Partial<AnsweredQuestion>): AnsweredQuestion => ({
    id: 'q', label: 'Q', type: 'text', required: true, answer: 'A', source: 'bank', needsHuman: false, ...over,
  });
  const job = (over: Partial<Job> = {}): Job => ({
    id: 'j1', source: 'greenhouse', sourceId: '1', company: 'Acme', title: 'PR Executive', location: 'Dublin', remote: false,
    url: 'https://example.test/j', applyUrl: 'https://example.test/j', ats: 'greenhouse', atsMeta: {}, description: '',
    status: 'ready', discoveredAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', score: 90, ...over,
  });

  it('parses answers in either container shape and round-trips', () => {
    const arr = parseAnswers(JSON.stringify([{ id: 'a', label: 'Why us?', type: 'textarea', required: true, answer: null, source: 'none', needsHuman: true }]));
    assert.equal(arr.list.length, 1);
    assert.equal(arr.shape.kind, 'array');
    const obj = parseAnswers(JSON.stringify({ jobId: 'j1', answers: [{ id: 'b', label: 'Visa?', answer: 'Yes' }, { nope: true }] }));
    assert.equal(obj.list.length, 1);
    assert.equal(obj.list[0].needsHuman, false);
    assert.equal(obj.list[0].source, 'bank');
    const back = JSON.parse(serializeAnswers(obj.list, obj.shape)) as { jobId: string; answers: unknown[] };
    assert.equal(back.jobId, 'j1');
    assert.equal(back.answers.length, 1);
    assert.deepEqual(parseAnswers('not json').list, []);
    assert.deepEqual(parseAnswers(undefined).list, []);
  });

  it('applies an edit and clears needsHuman', () => {
    const list = [q({ id: 'a', answer: null, needsHuman: true, source: 'none' }), q({ id: 'b' })];
    const next = applyAnswerEdit(list, 'a', '  Dublin  ');
    assert.equal(next[0].answer, 'Dublin');
    assert.equal(next[0].needsHuman, false);
    assert.equal(next[1], list[1]);
    assert.equal(applyAnswerEdit(list, 'a', '   ')[0].needsHuman, true);
    assert.throws(() => applyAnswerEdit(list, 'zzz', 'x'));
  });

  it('gates approval on CV, status and open questions (except unknown ATS)', () => {
    const open = [q({ answer: null, needsHuman: true })];
    assert.equal(approvalGate({ status: 'ready', ats: 'greenhouse', answers: [q({})], hasCv: true }).ok, true);
    const blocked = approvalGate({ status: 'ready', ats: 'greenhouse', answers: open, hasCv: true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocking, 1);
    assert.match(blocked.reason ?? '', /1 screening question needs/);
    assert.equal(approvalGate({ status: 'ready', ats: 'unknown', answers: open, hasCv: true }).ok, true);
    assert.equal(approvalGate({ status: 'ready', ats: 'greenhouse', answers: [], hasCv: false }).ok, false);
    assert.equal(approvalGate({ status: 'applied', ats: 'greenhouse', answers: [], hasCv: true }).ok, false);
    assert.equal(blockingAnswers([q({ needsHuman: true, answer: 'typed' })]).length, 0);
  });

  it('merges flags and decides batch eligibility strictly', () => {
    const flagged = job({ filters: { pass: true, rejected: [], flags: ['NI right-to-work'] }, scoreDetail: { total: 90, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: ['ni right-to-work', 'Visa phrase'], llmUsed: false, scoredAt: '' } });
    assert.deepEqual(jobFlags(flagged), ['NI right-to-work', 'Visa phrase']);
    const ok = { job: job(), answers: [q({})], flags: [], gate: { ok: true, blocking: 0 } };
    assert.equal(batchEligible(ok), true);
    assert.equal(batchEligible({ ...ok, job: job({ score: 84 }) }), false);
    assert.equal(batchEligible({ ...ok, flags: ['x'] }), false);
    assert.equal(batchEligible({ ...ok, answers: [q({ confirm: true })] }), false);
    assert.equal(batchEligible({ ...ok, gate: { ok: false, blocking: 0 } }), false);
  });

  it('parses ATS reports and letter findings defensively', () => {
    assert.equal(parseAtsReport('nope'), null);
    assert.equal(parseAtsReport('[]'), null);
    const r = parseAtsReport(JSON.stringify({ score: 88, pages: 2, problems: ['x', 3] }));
    assert.equal(r?.score, 88);
    assert.deepEqual(r?.problems, ['x']);
    assert.deepEqual(letterFindings({ guard: { ok: false, problems: ['€5k not in facts'] }, slop: { ok: false, hits: [{ rule: 'dash', match: '—' }] } }), {
      guardProblems: ['€5k not in facts'], slopHits: ['dash: —'], flags: [], edited: false,
    });
    assert.deepEqual(letterFindings({ guard: { ok: true, problems: [] }, slopHits: ['ai-vocab: delve'], flags: ['too long'], edited: true }), {
      guardProblems: [], slopHits: ['ai-vocab: delve'], flags: ['too long'], edited: true,
    });
    assert.deepEqual(letterFindings(undefined), { guardProblems: [], slopHits: [], flags: [], edited: false });
  });
});

// ───────────────────────────── Display + filter helpers ─────────────────────────────

import { formatSalary, locationLabel, postingUrl, safeLinkedInUrl } from '../src/components/job/format';
import { jobsHref, parseJobsFilter, toJobQuery } from '../src/components/job/filters';
import { describeEvent } from '../src/components/job/events';

describe('display helpers', () => {
  it('formats salaries compactly', () => {
    assert.equal(formatSalary({ min: 36000, max: 42000, currency: 'EUR' }), '€36k–42k');
    assert.equal(formatSalary({ min: 28500, currency: 'GBP' }), '£28.5k+');
    assert.equal(formatSalary({ max: 40000, currency: 'EUR' }), 'up to €40k');
    assert.equal(formatSalary({ raw: 'Competitive' }), 'Competitive');
    assert.equal(formatSalary(undefined), undefined);
  });

  it('labels locations', () => {
    assert.equal(locationLabel({ location: 'Dublin', remote: true }), 'Dublin · remote');
    assert.equal(locationLabel({ location: '', remote: true }), 'Remote');
    assert.equal(locationLabel({ location: 'Remote (IE)', remote: true }), 'Remote (IE)');
    assert.equal(locationLabel({ location: '', remote: false }), 'Location not stated');
  });

  it('only renders http(s) posting links', () => {
    assert.equal(postingUrl({ url: 'javascript:alert(1)', applyUrl: 'https://example.com/apply' }), 'https://example.com/apply');
    assert.equal(postingUrl({ url: 'data:text/html,x', applyUrl: 'not a url' }), undefined);
    assert.equal(postingUrl({ url: 'https://example.com/job', applyUrl: '' }), 'https://example.com/job');
  });

  it('accepts only https linkedin.com links for contacts', () => {
    assert.equal(safeLinkedInUrl('https://www.linkedin.com/in/someone'), 'https://www.linkedin.com/in/someone');
    assert.equal(safeLinkedInUrl('http://www.linkedin.com/in/someone'), undefined);
    assert.equal(safeLinkedInUrl('https://linkedin.com.evil.example/x'), undefined);
    assert.equal(safeLinkedInUrl('javascript:alert(1)'), undefined);
    assert.equal(safeLinkedInUrl(undefined), undefined);
  });

  it('describes status events', () => {
    const v = describeEvent({ id: 1, ts: '2026-11-15T10:00:00Z', type: 'status', jobId: 'j', detail: { from: 'ready', to: 'approved', detail: { by: 'kayzee' } } });
    assert.equal(v.title, 'Approved');
    assert.equal(v.tone, 'accent');
    assert.equal(describeEvent({ id: 2, ts: '2026-11-15T10:00:00Z', type: 'log.error', detail: { scope: 'apply', msg: 'boom' } }).tone, 'bad');
  });
});

describe('jobs filters', () => {
  it('parses and sanitises searchParams', () => {
    const f = parseJobsFilter({ status: ['ready', 'bogus', 'needs_you'], source: 'lever', min: '70', q: '  pr  ', sort: 'score', dir: 'asc', page: '3' });
    assert.deepEqual(f.statuses, ['ready', 'needs_you']);
    assert.equal(f.source, 'lever');
    assert.equal(f.minScore, 70);
    assert.equal(f.q, 'pr');
    assert.equal(f.sort, 'score');
    assert.equal(f.dir, 'asc');
    assert.equal(f.page, 3);
    const junk = parseJobsFilter({ source: 'evil', min: '-4', sort: 'drop table', page: 'x' });
    assert.equal(junk.source, undefined);
    assert.equal(junk.minScore, undefined);
    assert.equal(junk.sort, 'updatedAt');
    assert.equal(junk.page, 1);
  });

  it('round-trips through hrefs and builds paged queries', () => {
    const f = parseJobsFilter({ status: 'ready,applied', min: '60', page: '2' });
    const href = jobsHref(f, { page: 2 });
    const back = parseJobsFilter(Object.fromEntries([...new URL(href, 'http://x').searchParams].reduce((m, [k, v]) => {
      m.set(k, [...(m.get(k) ?? []), v]);
      return m;
    }, new Map<string, string[]>())));
    assert.deepEqual(back.statuses, ['ready', 'applied']);
    assert.equal(back.minScore, 60);
    assert.equal(back.page, 2);
    assert.equal(jobsHref(f), '/jobs?status=ready&status=applied&min=60');
    assert.deepEqual(toJobQuery(f), { status: ['ready', 'applied'], source: undefined, minScore: 60, search: undefined, orderBy: 'updatedAt', dir: 'desc', limit: 50, offset: 50 });
  });
});
