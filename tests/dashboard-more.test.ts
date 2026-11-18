// Secondary dashboard pages: pure helpers in src/lib/server-more.ts, the safe markdown parser and
// chart maths, plus the DB-backed loaders against a temp database. Never touches data/ or the network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-more-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'more.db');

const more = await import('../src/lib/server-more');
const dbm = await import('../src/lib/db');
const { parseMarkdown, parseInline } = await import('../src/components/comms/md-parse');
const { niceMax } = await import('../src/components/charts/DailyBars');
const { lintSlop } = await import('../src/engine/slop');
const { DEFAULT_SETTINGS, JOB_STATUSES, STATUS_GROUPS } = await import('../src/lib/types');
type Job = import('../src/lib/types').Job;
type NewJob = import('../src/lib/types').NewJob;
type FunnelStats = import('../src/lib/types').FunnelStats;

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'sources');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── parsing ─────────────────────────────

describe('form parsing', () => {
  test('parseList trims, dedupes case-insensitively and drops blanks', () => {
    assert.deepEqual(more.parseList(' Dublin, dublin ,\nCork,, '), ['Dublin', 'Cork']);
    assert.deepEqual(more.parseList('a, b\nc', /\n/), ['a, b', 'c']);
    assert.deepEqual(more.parseList(undefined), []);
  });

  test('parseNumber only accepts finite numbers', () => {
    assert.equal(more.parseNumber('42'), 42);
    assert.equal(more.parseNumber(' 2.5 '), 2.5);
    assert.equal(more.parseNumber(''), undefined);
    assert.equal(more.parseNumber('abc'), undefined);
    assert.equal(more.parseNumber(null), undefined);
  });

  test('isEmail and safeHttpUrl reject unsafe input', () => {
    assert.equal(more.isEmail('jane@company.ie'), true);
    assert.equal(more.isEmail('jane@company'), false);
    assert.equal(more.isEmail('Jane <jane@company.ie>'), false);
    assert.equal(more.safeHttpUrl('javascript:alert(1)'), undefined);
    assert.equal(more.safeHttpUrl('data:text/html,hi'), undefined);
    assert.equal(more.safeHttpUrl('https://calendly.com/x'), 'https://calendly.com/x');
    assert.equal(more.safeHttpUrl('not a url'), undefined);
  });
});

// ───────────────────────────── pipeline ─────────────────────────────

describe('pipeline transitions', () => {
  test('every status has an entry and never targets worker-owned states', () => {
    for (const s of JOB_STATUSES) {
      assert.ok(Array.isArray(more.PIPELINE_TRANSITIONS[s]), `missing ${s}`);
      for (const to of more.allowedTransitions(s)) {
        assert.ok(!['tailoring', 'applying', 'discovered', 'filtered_out', 'needs_you'].includes(to), `${s} -> ${to}`);
        assert.notEqual(to, s);
        assert.ok(more.TRANSITION_LABEL[to], `no label for ${to}`);
      }
    }
  });

  test('applied is reachable only after a handoff, a failure or a mistaken rejection', () => {
    const sources = JOB_STATUSES.filter((s) => more.canTransition(s, 'applied'));
    assert.deepEqual(sources.sort(), ['failed', 'needs_you', 'rejected']);
    assert.equal(more.canTransition('ready', 'applied'), false);
    assert.equal(more.canTransition('scored', 'approved'), false);
    assert.equal(more.canTransition('ready', 'approved'), true);
  });

  test('jobFlags merges and dedupes score flags, filter flags and needs', () => {
    const flags = more.jobFlags({
      scoreDetail: { total: 70, components: { skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }, reasons: [], flags: ['visa wording', ' NI right-to-work '], llmUsed: false, scoredAt: '' },
      filters: { pass: true, rejected: [], flags: ['visa wording'] },
      needs: ['captcha'],
    });
    assert.deepEqual(flags, ['visa wording', 'NI right-to-work', 'captcha']);
  });

  test('ageInDays and toPipelineCard', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    assert.equal(more.ageInDays('2026-11-12T11:00:00Z', now), 3);
    assert.equal(more.ageInDays('garbage', now), 0);
    assert.equal(more.ageInDays(undefined, now), 0);
    const card = more.toPipelineCard(job({ postedAt: '2026-11-01T00:00:00Z', needs: ['login'] }), now);
    assert.equal(card.ageDays, 14);
    assert.equal(card.flags, 1);
  });
});

// ───────────────────────────── inbox ─────────────────────────────

describe('inbox helpers', () => {
  test('kind tones match the brief', () => {
    assert.equal(more.INBOX_KIND_TONE.interview, 'good');
    assert.equal(more.INBOX_KIND_TONE.offer, 'good');
    assert.equal(more.INBOX_KIND_TONE.rejection, 'bad');
    assert.equal(more.INBOX_KIND_TONE.assessment, 'warn');
    assert.equal(more.INBOX_KIND_TONE.question, 'info');
    assert.equal(more.INBOX_KIND_TONE.confirmation, 'neutral');
    assert.equal(more.INBOX_KIND_TONE.job_alert, 'neutral');
    assert.equal(more.isEmailKind('offer'), true);
    assert.equal(more.isEmailKind('spam'), false);
  });

  test('extractCalendarLinks keeps only scheduling hosts, http(s), deduped', () => {
    const body = `Pick a slot: https://calendly.com/acme/30min. Or https://evil.example/calendly.com
      Meet: https://meet.google.com/abc-defg-hij, again https://calendly.com/acme/30min
      javascript:alert(1) https://teams.microsoft.com/l/meetup-join/xyz)`;
    assert.deepEqual(more.extractCalendarLinks(body), [
      'https://calendly.com/acme/30min',
      'https://meet.google.com/abc-defg-hij',
      'https://teams.microsoft.com/l/meetup-join/xyz',
    ]);
  });

  test('extrasFromEvents reads only events about this item and only safe links', () => {
    const item = { id: 7, messageId: '<m7@x>', body: 'see https://zoom.us/j/123' };
    const extras = more.extrasFromEvents(item, [
      { inboxId: 7, proposedTimes: ['Tue 10:00', 'Wed 14:00'], calendarUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE' },
      { messageId: '<m7@x>', proposedTimes: ['Tue 10:00', 'Thu 09:30'] },
      { inboxId: 8, proposedTimes: ['other item'] },
      { inboxId: 7, calendarUrl: 'javascript:alert(1)' },
      null,
      'string detail',
    ]);
    assert.deepEqual(extras.proposedTimes, ['Tue 10:00', 'Wed 14:00', 'Thu 09:30']);
    assert.match(extras.calendarUrl ?? '', /^https:\/\/calendar\.google\.com/);
    assert.deepEqual(extras.meetingLinks, ['https://zoom.us/j/123']);
  });

  test('mergeExtras dedupes across emails and keeps the first calendar link', () => {
    const merged = more.mergeExtras([
      { proposedTimes: ['a'], meetingLinks: ['https://zoom.us/1'], calendarUrl: undefined },
      { proposedTimes: ['a', 'b'], meetingLinks: ['https://zoom.us/1'], calendarUrl: 'https://calendar.google.com/1' },
      { proposedTimes: [], meetingLinks: [], calendarUrl: 'https://calendar.google.com/2' },
    ]);
    assert.deepEqual(merged, { proposedTimes: ['a', 'b'], meetingLinks: ['https://zoom.us/1'], calendarUrl: 'https://calendar.google.com/1' });
  });
});

// ───────────────────────────── recipients ─────────────────────────────

describe('checkRecipient: never sends to guessed addresses', () => {
  test('replying to the sender is verified', () => {
    assert.equal(more.checkRecipient({ to: 'Jane@Acme.ie' }, { inbox: { fromAddress: 'jane@acme.ie' } }).verified, true);
  });
  test('a verified contact is verified; a guessed one is not', () => {
    assert.equal(more.checkRecipient({ to: 'hr@acme.ie' }, { contact: { email: 'hr@acme.ie', emailVerified: true, source: 'jd' } }).verified, true);
    const guessed = more.checkRecipient({ to: 'jane.doe@acme.ie' }, { contact: { email: 'jane.doe@acme.ie', emailVerified: false, source: 'company_site' } });
    assert.equal(guessed.verified, false);
    assert.match(guessed.reason, /guessed/i);
  });
  test('missing, invalid or unknown addresses are not verified', () => {
    assert.equal(more.checkRecipient({ to: undefined }, {}).verified, false);
    assert.equal(more.checkRecipient({ to: 'nope' }, {}).verified, false);
    assert.equal(more.checkRecipient({ to: 'x@acme.ie' }, { jobSenders: ['y@acme.ie'] }).verified, false);
    assert.equal(more.checkRecipient({ to: 'y@acme.ie' }, { jobSenders: ['Y@acme.ie'] }).verified, true);
  });
});

// ───────────────────────────── interviews ─────────────────────────────

describe('thank-you notes', () => {
  const profile = { name: { first: 'Kshitiz', last: 'Mittal', preferred: 'Kayzee', full: 'Kshitiz Mittal' }, coverLetter: { signOff: 'Kind Regards,\nKayzee', voiceNotes: [] } };

  test('senderFirstName handles display names, roles and bare addresses', () => {
    assert.equal(more.senderFirstName('"Aoife Byrne" <aoife@acme.ie>'), 'Aoife');
    assert.equal(more.senderFirstName('seán ó briain <s@x.ie>'), 'Seán');
    assert.equal(more.senderFirstName('careers@acme.ie'), undefined);
    assert.equal(more.senderFirstName('Talent Team <talent@acme.ie>'), undefined);
    assert.equal(more.senderFirstName('No Reply <noreply@acme.ie>'), undefined);
    assert.equal(more.senderFirstName(undefined), undefined);
  });

  test('template is signed correctly, makes no claims and passes the slop lint', () => {
    const { subject, body } = more.thankYouTemplate({ job: { title: 'PR Executive', company: 'Acme' }, firstName: 'Aoife', profile });
    assert.match(subject, /PR Executive/);
    assert.ok(body.startsWith('Hi Aoife,'));
    assert.ok(body.endsWith('Kind Regards,\nKayzee\nKshitiz Mittal'));
    assert.doesNotMatch(body, /[–—]/);
    assert.doesNotMatch(body, /\d/, 'no numbers means nothing for the truth guard to check');
    const slop = lintSlop(body);
    assert.equal(slop.ok, true, JSON.stringify(slop.hits));
    assert.ok(more.thankYouTemplate({ job: { title: 'X', company: 'Y' }, profile }).body.startsWith('Hi there,'));
  });
});

// ───────────────────────────── analytics ─────────────────────────────

describe('analytics helpers', () => {
  test('funnelSteps computes step conversion and guards zero bases', () => {
    const f: FunnelStats = { discovered: 200, scored: 100, ready: 20, applied: 10, replied: 3, interview: 1, offer: 0, rejected: 2, appliedToday: 0, appliedWeek: 0, responseRate: 0.3 };
    const steps = more.funnelSteps(f);
    assert.deepEqual(steps.map((s) => s.value), [200, 100, 20, 10, 3, 1, 0]);
    assert.equal(steps[0].conversion, null);
    assert.equal(steps[1].conversion, 50);
    assert.equal(steps[4].conversion, 30);
    const zero = more.funnelSteps({ ...f, discovered: 0, scored: 0 });
    assert.equal(zero[1].conversion, null);
  });

  test('aggregateGaps counts each job once per term and ranks by frequency', () => {
    const cov = (gaps: string[]) => ({ keywords: [], matched: [], gaps, pct: 0 });
    const gaps = more.aggregateGaps([
      { company: 'A', title: 'PR Exec', keywords: cov(['Meltwater', 'meltwater', 'Cision']) },
      { company: 'B', title: 'Comms Officer', keywords: cov(['Meltwater', 'Irish language']) },
      { company: 'C', title: 'Content Exec', keywords: cov(['Meltwater']) },
      { company: 'D', title: 'No data', keywords: undefined },
    ]);
    assert.equal(gaps[0].term, 'Meltwater');
    assert.equal(gaps[0].jobs, 3);
    assert.deepEqual(gaps[0].examples, ['PR Exec at A', 'Comms Officer at B', 'Content Exec at C']);
    assert.deepEqual(gaps.slice(1).map((g) => g.term), ['Cision', 'Irish language']);
    assert.equal(more.aggregateGaps([], 5).length, 0);
  });

  test('groupResponseRates buckets rows by dimension', () => {
    const g = more.groupResponseRates([
      { dimension: 'source', key: 'greenhouse', applied: 4, responded: 1, interviews: 0, rate: 0.25 },
      { dimension: 'scoreBucket', key: '80-100', applied: 2, responded: 1, interviews: 1, rate: 0.5 },
    ]);
    assert.equal(g.source.length, 1);
    assert.equal(g.scoreBucket.length, 1);
    assert.equal(g.ats.length, 0);
    assert.equal(g.summaryVariant.length, 0);
  });

  test('niceMax gives readable axis maxima', () => {
    assert.equal(niceMax(0), 4);
    assert.equal(niceMax(3), 4);
    assert.equal(niceMax(7), 10);
    assert.equal(niceMax(12), 20);
    assert.equal(niceMax(23), 25);
    assert.equal(niceMax(51), 100);
  });
});

// ───────────────────────────── sources ─────────────────────────────

describe('board tests', () => {
  test('token validation blocks anything that is not a slug', () => {
    assert.equal(more.isValidBoardToken('intercom'), true);
    assert.equal(more.isValidBoardToken('acme_ie-2.0'), true);
    for (const bad of ['', '../etc', 'a/b', 'a b', 'x?y=1', '-lead', 'a'.repeat(101)]) assert.equal(more.isValidBoardToken(bad), false, bad);
  });

  test('boardApiUrl targets the public logged-out APIs', () => {
    assert.equal(more.boardApiUrl('greenhouse', 'intercom'), 'https://boards-api.greenhouse.io/v1/boards/intercom/jobs');
    assert.equal(more.boardApiUrl('lever', 'cartrawler'), 'https://api.lever.co/v0/postings/cartrawler?mode=json');
    assert.match(more.boardApiUrl('ashby', 'notion'), /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/notion$/);
    assert.match(more.boardApiUrl('smartrecruiters', 'Acme'), /^https:\/\/api\.smartrecruiters\.com\/v1\/companies\/Acme\/postings/);
    assert.match(more.boardApiUrl('workable', 'acme'), /^https:\/\/apply\.workable\.com\/api\/v1\/widget\/accounts\/acme$/);
  });

  test('countBoardJobs reads each ATS shape (recorded fixtures)', () => {
    const gh = more.countBoardJobs('greenhouse', fixture('greenhouse.json'));
    assert.ok(gh && gh.total > 0 && gh.ireland > 0 && gh.ireland <= gh.total, JSON.stringify(gh));
    const lv = more.countBoardJobs('lever', fixture('lever.json'));
    assert.ok(lv && lv.total > 0, JSON.stringify(lv));
    const ab = more.countBoardJobs('ashby', fixture('ashby.json'));
    assert.ok(ab && ab.total > 0, JSON.stringify(ab));
    const sr = more.countBoardJobs('smartrecruiters', fixture('smartrecruiters_list_ie.json'));
    assert.ok(sr && sr.total > 0, JSON.stringify(sr));
    assert.deepEqual(more.countBoardJobs('workable', { jobs: [{ country: 'Ireland', city: 'Dublin' }, { country: 'Germany' }] }), { total: 2, ireland: 1 });
    assert.equal(more.countBoardJobs('greenhouse', { nope: true }), null);
    assert.equal(more.countBoardJobs('lever', { jobs: [] }), null);
  });

  test('testBoard does one GET and reports counts or a clear error', async () => {
    const calls: string[] = [];
    const okFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ jobs: [{ location: { name: 'Dublin, Ireland' } }, { location: { name: 'London' } }] }), { status: 200 });
    }) as typeof fetch;
    const r = await more.testBoard('greenhouse', 'acme', okFetch);
    assert.deepEqual({ ok: r.ok, total: r.total, ireland: r.ireland }, { ok: true, total: 2, ireland: 1 });
    assert.equal(calls.length, 1);

    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const r404 = await more.testBoard('lever', 'missing', notFound);
    assert.equal(r404.ok, false);
    assert.match(r404.error ?? '', /404/);

    const throws = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    assert.match((await more.testBoard('ashby', 'x', throws)).error ?? '', /ECONNREFUSED/);

    const never = (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch;
    assert.equal((await more.testBoard('greenhouse', '../../x', never)).ok, false);
  });

  test('parseSourceRun tolerates the shapes discovery may write', () => {
    assert.deepEqual(more.parseSourceRun('2026-11-15T08:00:00Z'), { at: '2026-11-15T08:00:00Z' });
    assert.deepEqual(more.parseSourceRun({ at: 'x', found: 12, created: 3, ok: true }), { at: 'x', ok: true, found: 12, created: 3, error: undefined });
    assert.deepEqual(more.parseSourceRun({ ts: 'y', fetched: 4, error: 'HTTP 500' }), { at: 'y', ok: false, found: 4, created: undefined, error: 'HTTP 500' });
    assert.equal(more.parseSourceRun(null), null);
    assert.equal(more.parseSourceRun(42), null);
  });
});

// ───────────────────────────── settings ─────────────────────────────

describe('settings helpers', () => {
  const bank = {
    entries: [
      { id: 'notice', patterns: ['notice period'], answer: '2 weeks', confirm: true },
      { id: 'city', patterns: ['city'], answer: 'Dundalk' },
    ],
  };

  test('confirm / upsert / remove answer entries are pure', () => {
    const confirmed = more.confirmAnswerEntry(bank, 'notice');
    assert.equal(confirmed.entries[0].confirm, false);
    assert.equal(bank.entries[0].confirm, true, 'input not mutated');
    assert.throws(() => more.confirmAnswerEntry(bank, 'missing'));
    const upserted = more.upsertAnswerEntry(bank, { id: 'city', patterns: ['city'], answer: 'Dublin' });
    assert.equal(upserted.entries.length, 2);
    assert.equal(upserted.entries[1].answer, 'Dublin');
    assert.equal(more.upsertAnswerEntry(bank, { id: 'new', patterns: ['x'], answer: 'y' }).entries.length, 3);
    assert.deepEqual(more.removeAnswerEntry(bank, 'notice').entries.map((e) => e.id), ['city']);
  });

  test('slugify makes safe ids', () => {
    assert.equal(more.slugify('When can you START?'), 'when-can-you-start');
    assert.equal(more.slugify('Café / Résumé'), 'cafe-resume');
    assert.equal(more.slugify('???'), 'entry');
  });

  test('groupFacts orders kinds and keeps every fact', () => {
    const groups = more.groupFacts([
      { id: 'a', kind: 'skill', text: 'x', tags: [] },
      { id: 'b', kind: 'role', text: 'y', tags: [] },
      { id: 'c', kind: 'role', text: 'z', tags: [] },
    ]);
    assert.deepEqual(groups.map((g) => g.kind), ['role', 'skill']);
    assert.equal(groups[0].facts.length, 2);
  });

  test('autopilot is active only with mode + enabled, and its limits list SPEC §7', () => {
    assert.equal(more.autopilotActive(DEFAULT_SETTINGS), false);
    assert.equal(more.autopilotActive({ ...DEFAULT_SETTINGS, mode: 'autopilot' }), false);
    const on = { ...DEFAULT_SETTINGS, mode: 'autopilot' as const, autopilot: { ...DEFAULT_SETTINGS.autopilot, enabled: true } };
    assert.equal(more.autopilotActive(on), true);
    const text = more.autopilotLimits(on).join('\n');
    for (const needle of ['85', 'Greenhouse, Lever, Ashby', '80', 'Truth guard', 'answer bank', 'No flags', '22:00', 'never auto-sent']) {
      assert.ok(text.includes(needle), `limits should mention ${needle}`);
    }
    assert.match(more.autopilotLimits({ ...on, autopilot: { ...on.autopilot, ats: [] } }).join('\n'), /nothing qualifies/);
  });
});

// ───────────────────────────── markdown ─────────────────────────────

describe('safe markdown parser', () => {
  test('headings, lists, bold, paragraphs and rules', () => {
    const blocks = parseMarkdown('# Brief\n\nAcme does **PR**.\nSecond line.\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n---\n### Ask');
    assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'rule', 'heading']);
    const para = blocks[1];
    assert.ok(para.type === 'paragraph');
    assert.deepEqual(para.content, [{ type: 'text', text: 'Acme does ' }, { type: 'strong', children: [{ type: 'text', text: 'PR' }] }, { type: 'text', text: '. Second line.' }]);
    const list = blocks[2];
    assert.ok(list.type === 'list' && !list.ordered && list.items.length === 2);
    assert.deepEqual(list.items[1], [{ type: 'text', text: 'two continued' }]);
    assert.ok(blocks[3].type === 'list' && blocks[3].ordered);
  });

  test('raw HTML stays literal text (never markup)', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> **<img src=x onerror=alert(1)>**');
    const p = blocks[0];
    assert.ok(p.type === 'paragraph');
    assert.deepEqual(p.content[0], { type: 'text', text: '<script>alert(1)</script> ' });
    assert.deepEqual(p.content[1], { type: 'strong', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] });
  });

  test('unmatched markers and snake_case are left alone', () => {
    assert.deepEqual(parseInline('2 * 3 and **open'), [{ type: 'text', text: '2 * 3 and **open' }]);
    assert.deepEqual(parseInline('use snake_case_name'), [{ type: 'text', text: 'use snake_case_name' }]);
    assert.deepEqual(parseInline('`code` *em*'), [{ type: 'code', text: 'code' }, { type: 'text', text: ' ' }, { type: 'em', children: [{ type: 'text', text: 'em' }] }]);
  });
});

// ───────────────────────────── DB-backed loaders ─────────────────────────────

function newJob(over: Partial<NewJob> & { id: string }): NewJob {
  return {
    source: 'greenhouse', sourceId: over.id, company: 'Acme Comms', title: 'PR Executive', location: 'Dublin, Ireland', country: 'IE',
    remote: false, url: `https://boards.example.test/acme/${over.id}`, applyUrl: `https://boards.example.test/acme/${over.id}`,
    ats: 'greenhouse', atsMeta: {}, description: 'Sample description.', ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return { ...newJob({ id: 'j0' }), status: 'ready', discoveredAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...over };
}

describe('DB-backed loaders (temp DB)', () => {
  before(() => {
    dbm.upsertJob(newJob({ id: 'aaaa000000000001', title: 'PR Executive' }));
    dbm.updateJob('aaaa000000000001', { score: 82 });
    dbm.setStatus('aaaa000000000001', 'ready');
    dbm.upsertJob(newJob({ id: 'aaaa000000000002', company: 'Beta', title: 'Comms Officer' }));
    dbm.setStatus('aaaa000000000002', 'interview');
    dbm.upsertJob(newJob({ id: 'aaaa000000000003', company: 'Gamma', title: 'Content Exec' }));
    dbm.setStatus('aaaa000000000003', 'rejected');
    dbm.upsertJob(newJob({ id: 'aaaa000000000004', source: 'manual', company: 'Demo Corp', title: 'Demo role', atsMeta: { demo: true } }));
  });

  test('pipelineColumns follows STATUS_GROUPS with correct totals', () => {
    const cols = more.pipelineColumns();
    assert.deepEqual(cols.map((c) => c.name), Object.keys(STATUS_GROUPS));
    const by = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.equal(by.Ready.total, 1);
    assert.equal(by.Ready.cards[0].score, 82);
    assert.equal(by.Interview.total, 1);
    assert.equal(by.Closed.total, 1);
    assert.equal(by.Inbox.total, 1, 'the demo job is still discovered');
  });

  test('inbox list, counts and detail link replies + extras', () => {
    const { item } = dbm.addInbox({
      messageId: '<i1@beta.test>', fromAddress: 'aoife@beta.test', from: 'Aoife Byrne <aoife@beta.test>', subject: 'Interview invite',
      date: '2026-11-14T09:00:00Z', body: 'Book here: https://calendly.com/beta/30', jobId: 'aaaa000000000002', kind: 'interview', confidence: 0.9, summary: 'Invite',
    });
    dbm.addInbox({ messageId: '<i2@x.test>', fromAddress: 'alerts@x.test', from: 'Alerts <alerts@x.test>', subject: 'Jobs', date: '2026-11-14T10:00:00Z', body: 'list', kind: 'job_alert' });
    dbm.logEvent('inbox.interview', { inboxId: item.id, proposedTimes: ['Tue 10:00'] }, 'aaaa000000000002');
    dbm.addMessage({ jobId: 'aaaa000000000002', inboxId: item.id, direction: 'out', channel: 'email', kind: 'reply', to: 'aoife@beta.test', subject: 'Re: Interview invite', body: 'Hi Aoife', status: 'draft' });

    const counts = more.inboxKindCounts();
    assert.equal(counts.all, 2);
    assert.equal(counts.interview, 1);
    assert.equal(counts.job_alert, 1);
    assert.equal(more.inboxList({ kind: 'interview' }).length, 1);
    assert.equal(more.inboxList({ kind: 'interview' })[0].job?.company, 'Beta');

    const detail = more.inboxDetail(item.id);
    assert.ok(detail);
    assert.equal(detail.replies.length, 1);
    assert.deepEqual(detail.extras.proposedTimes, ['Tue 10:00']);
    assert.deepEqual(detail.extras.meetingLinks, ['https://calendly.com/beta/30']);
    assert.equal(more.recipientCheckFor(detail.replies[0]).verified, true);
    assert.equal(more.inboxDetail(999_999), undefined);

    dbm.updateInbox(item.id, { handled: true });
    assert.equal(more.inboxKindCounts().all, 1);
    assert.equal(more.inboxKindCounts(true).all, 2);
  });

  test('outreachData splits drafts, LinkedIn notes, sent and contacts', () => {
    const verified = dbm.upsertContact({ company: 'Acme Comms', jobId: 'aaaa000000000001', email: 'jobs@acme.test', emailVerified: true, source: 'jd', confidence: 0.9 });
    const guessed = dbm.upsertContact({ company: 'Acme Comms', jobId: 'aaaa000000000001', name: 'Pat Guess', email: 'pat@acme.test', emailVerified: false, source: 'company_site', confidence: 0.3 });
    dbm.addMessage({ jobId: 'aaaa000000000001', contactId: verified.id, direction: 'out', channel: 'email', kind: 'outreach', to: 'jobs@acme.test', subject: 'Hello', body: 'Hi', status: 'draft' });
    dbm.addMessage({ jobId: 'aaaa000000000001', contactId: guessed.id, direction: 'out', channel: 'email', kind: 'outreach', to: 'pat@acme.test', subject: 'Hello', body: 'Hi', status: 'draft' });
    dbm.addMessage({ jobId: 'aaaa000000000001', direction: 'out', channel: 'linkedin', kind: 'linkedin_note', body: 'Short note', status: 'draft' });
    dbm.addMessage({ jobId: 'aaaa000000000001', direction: 'out', channel: 'email', kind: 'follow_up', to: 'jobs@acme.test', body: 'Done', status: 'sent' });
    dbm.addMessage({ direction: 'out', channel: 'email', kind: 'digest', to: 'me@x.test', body: 'digest', status: 'sent' });

    const data = more.outreachData();
    const outreach = data.emailDrafts.filter((d) => d.message.kind === 'outreach');
    assert.equal(outreach.length, 2);
    assert.equal(outreach.find((d) => d.message.to === 'jobs@acme.test')?.recipient.verified, true);
    assert.equal(outreach.find((d) => d.message.to === 'pat@acme.test')?.recipient.verified, false);
    assert.equal(data.linkedinNotes.length, 1);
    assert.ok(data.sent.every((d) => d.message.kind !== 'digest'), 'digests are not outreach');
    assert.equal(data.contacts.length, 2);
    assert.equal(data.contacts[0].job?.company, 'Acme Comms');
  });

  test('interviewsData includes emails, extras and thank-you drafts', () => {
    dbm.addArtifact({ jobId: 'aaaa000000000002', kind: 'prep', content: '# Prep\n\n- Q1' });
    dbm.addMessage({ jobId: 'aaaa000000000002', direction: 'out', channel: 'email', kind: 'thank_you', to: 'aoife@beta.test', body: 'Thanks', status: 'draft' });
    const views = more.interviewsData();
    assert.equal(views.length, 1);
    const v = views[0];
    assert.equal(v.job.company, 'Beta');
    assert.equal(v.emails.length, 1);
    assert.equal(v.prep?.text, '# Prep\n\n- Q1');
    assert.equal(v.thankYou.length, 1);
    assert.deepEqual(more.interviewerAddress('aaaa000000000002'), { address: 'aoife@beta.test', name: 'Aoife' });
  });

  test('readArtifactText refuses files outside data/artifacts', () => {
    const outside = path.join(TMP, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    assert.equal(more.readArtifactText({ id: 1, jobId: 'x', kind: 'prep', path: outside, version: 1, createdAt: '' }), undefined);
    assert.equal(more.readArtifactText({ id: 1, jobId: 'x', kind: 'prep', path: '/etc/passwd', version: 1, createdAt: '' }), undefined);
    assert.equal(more.readArtifactText(undefined), undefined);
  });

  test('topGapKeywords, sourceRuns and demoJobCount', () => {
    dbm.updateJob('aaaa000000000001', { keywords: { keywords: [], matched: [], gaps: ['Meltwater'], pct: 40 } });
    const { gaps, jobsConsidered } = more.topGapKeywords();
    assert.equal(jobsConsidered, 2);
    assert.deepEqual(gaps.map((g) => g.term), ['Meltwater']);

    dbm.kvSet('source.greenhouse.lastRun', { at: '2026-11-15T08:00:00Z', found: 30, created: 2 });
    const runs = more.sourceRuns();
    assert.equal(runs.greenhouse?.found, 30);
    assert.equal(runs.lever, null);

    assert.equal(more.demoJobCount(), 1);
  });
});
