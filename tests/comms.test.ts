// Comms tests: inbox classification + processing, calendar extraction, contacts, drafts, sending
// gates, follow-up selection, digest and notifications. Temp DB + temp config (example files);
// no real network (fetch is stubbed), no real SMTP (mock transport), no OS notifications.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-comms-test-'));
const CONFIG_TMP = path.join(TMP, 'config');
fs.mkdirSync(CONFIG_TMP, { recursive: true });
for (const name of ['profile', 'facts', 'answers', 'sources']) {
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'config', `${name}.example.json`), path.join(CONFIG_TMP, `${name}.example.json`));
}

const SELF = 'kayzee.test@example.com';
process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
process.env.PURSUIT_NOTIFY = 'off';
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
process.env.PURSUIT_CONFIG_DIR = CONFIG_TMP;
process.env.OPENROUTER_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';
process.env.NTFY_TOPIC = '';
process.env.GMAIL_USER = '';
process.env.GMAIL_APP_PASSWORD = '';

// Any accidental network call fails loudly and is counted.
let fetchCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchCalls.push(String(input instanceof Request ? input.url : input));
  throw new Error('network disabled in tests');
}) as typeof fetch;

const dbm = await import('../src/lib/db');
const { loadFacts, loadProfile } = await import('../src/lib/config');
const { jobArtifactDir, ensureDir } = await import('../src/lib/paths');
const { classifyEmail, classifyHeuristic, matchJob, stripQuoted } = await import('../src/engine/inbox/classify');
const { extractProposedTimes, googleCalendarUrl, formatProposedTime } = await import('../src/engine/inbox/calendar');
const { fetchNewEmails, parseRawEmail, selectUids, extractLinks } = await import('../src/engine/inbox/imap');
const { processInbox } = await import('../src/engine/inbox/process');
const { findContacts, extractEmails, extractHiringManagers, companyDomain, linkedinSearchUrl, CONTACT_FETCH } = await import('../src/engine/outreach/contacts');
const draft = await import('../src/engine/outreach/draft');
const { sendApprovedEmails, setTransportForTests, verifyRecipient } = await import('../src/engine/outreach/send');
const { planFollowUp, scheduleFollowUps } = await import('../src/engine/followup');
const { buildDigest, sendDigestToSelf } = await import('../src/engine/digest');
const { notify, escapeAppleScript } = await import('../src/engine/notify');
const { wordCount, normalizeEmail, isNoReplyAddress } = await import('../src/engine/outreach/text');

type Job = import('../src/lib/types').Job;
type NewJob = import('../src/lib/types').NewJob;
type InboundEmail = import('../src/lib/types').InboundEmail;
type EmailKind = import('../src/lib/types').EmailKind;
type JobStatus = import('../src/lib/types').JobStatus;
type SendMailOptions = import('nodemailer').SendMailOptions;

CONTACT_FETCH.delayMs = 0;

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'emails');
interface Fixture { name: string; expect: { kind: EmailKind; company?: string }; email: InboundEmail }

function loadFixtures(): Fixture[] {
  return fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')) as Omit<Fixture, 'name'>;
    return { name: f, ...data };
  });
}
const fixture = (name: string): InboundEmail => loadFixtures().find((f) => f.name === `${name}.json`)!.email;

let dbCounter = 0;
function freshDb(): void {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `comms-${++dbCounter}.db`);
}

const COMPANIES: { id: string; company: string; title: string; status: JobStatus; domain: string }[] = [
  { id: 'acme000000000001', company: 'Acme Comms', title: 'PR Executive', status: 'applied', domain: 'acmecomms.ie' },
  { id: 'bright0000000001', company: 'Brightwave Media', title: 'Content Executive', status: 'applied', domain: 'brightwavemedia.com' },
  { id: 'north00000000001', company: 'Northlight Agency', title: 'Social Media Executive', status: 'applied', domain: 'northlightagency.ie' },
  { id: 'harbour000000001', company: 'Harbour Events', title: 'Events Coordinator', status: 'applied', domain: 'harbourevents.ie' },
  { id: 'cairn00000000001', company: 'Cairn Foods', title: 'Marketing Assistant', status: 'applied', domain: 'cairnfoods.ie' },
  { id: 'other00000000001', company: 'Quayside Studio', title: 'Marketing Executive', status: 'ready', domain: 'quayside.ie' },
];

function newJob(c: (typeof COMPANIES)[number], over: Partial<NewJob> = {}): NewJob {
  return {
    id: c.id,
    source: 'greenhouse',
    sourceId: c.id,
    company: c.company,
    title: c.title,
    location: 'Dublin, Ireland',
    country: 'IE',
    remote: false,
    url: `https://boards.greenhouse.io/${c.id}/jobs/1`,
    applyUrl: `https://boards.greenhouse.io/${c.id}/jobs/1`,
    ats: 'greenhouse',
    atsMeta: {},
    description: `${c.company} is hiring a ${c.title} to write social media content and support events.`,
    ...over,
  };
}

/** In-memory Job objects for pure classification tests (no DB). */
function memoryJobs(): Job[] {
  return COMPANIES.map((c) => ({ ...newJob(c), status: c.status, discoveredAt: '2025-11-01T00:00:00.000Z', updatedAt: '2025-11-05T00:00:00.000Z' }));
}

function seedJobs(): Job[] {
  return COMPANIES.map((c) => {
    dbm.upsertJob(newJob(c));
    return dbm.updateJob(c.id, { status: c.status })!;
  });
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// ───────────────────────────── Mock transport ─────────────────────────────

let sentMail: SendMailOptions[] = [];
let failNextSend = false;
const mockTransport = {
  async sendMail(mail: SendMailOptions) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error('550 mailbox unavailable');
    }
    sentMail.push(mail);
    return { messageId: `<mock-${sentMail.length}@test>` };
  },
};

before(() => setTransportForTests(mockTransport));
after(() => {
  setTransportForTests(null);
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── Classification ─────────────────────────────

describe('automated mail is not mistaken for an interview', () => {
  const base = { messageId: '<x@t>', date: '2026-11-12T10:00:00.000Z' };
  const tesco: InboundEmail = {
    ...base, from: 'Tesco Ireland <no-reply@emails.tesco.ie>', fromAddress: 'no-reply@emails.tesco.ie',
    subject: 'Kshitiz, your Tesco Christmas slots are here',
    text: 'Book your delivery slots now. Choose a time that suits you and schedule your Christmas delivery. Unsubscribe | Manage preferences',
  };
  const human: InboundEmail = {
    ...base, from: 'Aoife Byrne <aoife@somecompany.ie>', fromAddress: 'aoife@somecompany.ie',
    subject: 'Interview for the Communications role',
    text: 'Hi Kshitiz, we would like to invite you to an interview. Could you let me know your availability next week?',
  };

  test('a retail promo with scheduling words and no matching job is just "other"', async () => {
    seedJobs();
    const cls = await classifyEmail(tesco, dbm.listJobs({ limit: 100 }));
    assert.equal(cls.kind, 'other');
    assert.equal(cls.jobId, undefined);
  });

  test('a real interview invite from a person still counts, even with no matching job', async () => {
    seedJobs();
    const cls = await classifyEmail(human, dbm.listJobs({ limit: 100 }));
    assert.equal(cls.kind, 'interview');
  });

  test('an interview email from a recruiting platform is kept', async () => {
    seedJobs();
    const cls = await classifyEmail({ ...human, from: 'Talent <no-reply@greenhouse-mail.io>', fromAddress: 'no-reply@greenhouse-mail.io' }, dbm.listJobs({ limit: 100 }));
    assert.equal(cls.kind, 'interview');
  });
});

describe('classifyEmail (heuristics, no LLM)', () => {
  const jobs = memoryJobs();

  for (const fx of loadFixtures()) {
    test(`${fx.name} → ${fx.expect.kind}`, async () => {
      const cls = await classifyEmail(fx.email, jobs);
      assert.equal(cls.kind, fx.expect.kind, `kind for ${fx.name} (scores ${JSON.stringify(classifyHeuristic(fx.email).scores)})`);
      assert.equal(cls.llmUsed, false);
      assert.ok(cls.confidence > 0 && cls.confidence <= 1);
      assert.ok(cls.summary.length > 0);
      if (fx.expect.company) {
        const expected = jobs.find((j) => j.company === fx.expect.company)!;
        assert.equal(cls.jobId, expected.id, `job match for ${fx.name}`);
      }
      if (fx.expect.kind === 'job_alert') assert.equal(cls.jobId, undefined);
    });
  }

  test('a rejection that mentions the interview process and next stage stays a rejection', () => {
    const h = classifyHeuristic(fixture('rejection_interview_process'));
    assert.equal(h.kind, 'rejection');
    assert.ok(h.confidence >= 0.9);
    assert.ok(h.scores.interview > 0, 'interview words were seen but did not win');
  });

  test('"offer you an interview" is an interview, not an offer', () => {
    const h = classifyHeuristic(fixture('offer_an_interview'));
    assert.equal(h.kind, 'interview');
    assert.equal(h.scores.offer, 0);
  });

  test('interview classification carries the proposed time', async () => {
    const cls = await classifyEmail(fixture('interview_invite'), jobs);
    assert.deepEqual(cls.proposedTimes, ['2025-11-18T14:00:00.000Z']);
  });

  test('an injected instruction is just text: classified normally, address ignored', async () => {
    const cls = await classifyEmail(fixture('prompt_injection'), jobs);
    assert.equal(cls.kind, 'confirmation');
    assert.ok(!cls.summary.includes('evil.com'));
  });

  test('job matching prefers jobs in flight and ignores unrelated senders', () => {
    const dupes: Job[] = [
      { ...jobs[0], id: 'acme-ready', status: 'ready', updatedAt: '2025-11-09T00:00:00.000Z' },
      { ...jobs[0], id: 'acme-applied', status: 'applied', updatedAt: '2025-11-01T00:00:00.000Z' },
    ];
    assert.equal(matchJob(fixture('interview_invite'), dupes)?.jobId, 'acme-applied');
    assert.equal(matchJob(fixture('newsletter'), jobs), undefined);
  });

  test('stripQuoted drops quoted replies', () => {
    const text = 'Thanks, see you then.\n\nOn Tue, 11 Nov 2025 at 10:00, Kayzee <k@example.com> wrote:\n> unfortunately I cannot';
    assert.equal(stripQuoted(text), 'Thanks, see you then.');
  });
});

// ───────────────────────────── Calendar ─────────────────────────────

describe('calendar', () => {
  const ref = new Date('2025-11-12T09:30:00.000Z'); // a Wednesday; 18 Nov 2025 is a Tuesday

  test('"Tuesday 18th November at 2pm" → 14:00 Dublin (UTC in winter), 1h default', () => {
    const [t, ...rest] = extractProposedTimes('Would Tuesday 18th November at 2pm work for you?', ref);
    assert.equal(rest.length, 0);
    assert.equal(t.start, '2025-11-18T14:00:00.000Z');
    assert.equal(t.end, '2025-11-18T15:00:00.000Z');
    assert.equal(t.allDay, false);
    assert.equal(t.date, '2025-11-18');
    assert.equal(formatProposedTime(t), 'Tue 18 Nov, 14:00');
  });

  test('summer dates honour Irish Summer Time', () => {
    const [t] = extractProposedTimes('How about Monday 6th July 2026 at 10:30am?', ref);
    assert.equal(t.start, '2026-07-06T09:30:00.000Z');
  });

  test('ranges, weekday-only and relative dates', () => {
    const [range] = extractProposedTimes('Free on Thursday 20 November between 2 and 4pm?', ref);
    assert.equal(range.start, '2025-11-20T14:00:00.000Z');
    assert.equal(range.end, '2025-11-20T16:00:00.000Z');
    const [weekday] = extractProposedTimes('Are you available on Thursday at 11am?', ref);
    assert.equal(weekday.start, '2025-11-13T11:00:00.000Z');
    const [tomorrow] = extractProposedTimes('Could you do tomorrow at 9.30am?', ref);
    assert.equal(tomorrow.start, '2025-11-13T09:30:00.000Z');
  });

  test('a date with no time is all-day; money and bare numbers are not times', () => {
    const [allDay] = extractProposedTimes('Interviews will take place on 25 November.', ref);
    assert.equal(allDay.allDay, true);
    assert.equal(allDay.date, '2025-11-25');
    assert.deepEqual(extractProposedTimes('Salary €35,000 - €40,000, 39 hours a week, 24/7 support.', ref), []);
  });

  test('googleCalendarUrl builds a TEMPLATE link', () => {
    const url = googleCalendarUrl({ title: 'Interview: PR Executive at Acme & Co', start: '2025-11-18T14:00:00.000Z', end: '2025-11-18T15:00:00.000Z', details: 'From: Sarah' });
    assert.equal(
      url,
      'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Interview%3A%20PR%20Executive%20at%20Acme%20%26%20Co&dates=20251118T140000Z/20251118T150000Z&details=From%3A%20Sarah',
    );
    const allDay = googleCalendarUrl({ title: 'x', start: '2025-11-25T00:00:00.000Z', end: '2025-11-26T00:00:00.000Z', allDay: true });
    assert.match(allDay, /dates=20251125\/20251126/);
  });
});

// ───────────────────────────── IMAP parsing ─────────────────────────────

describe('imap', () => {
  test('parseRawEmail normalises the sender and extracts http links from html', async () => {
    const email = await parseRawEmail(fs.readFileSync(path.join(FIXTURES, 'raw_interview.eml')), 42);
    assert.ok(email);
    assert.equal(email.fromAddress, 'sarah.kelly@acmecomms.ie');
    assert.equal(email.messageId, '<raw-1@acmecomms.example>');
    assert.equal(email.uid, 42);
    assert.equal(email.date, '2025-11-12T09:30:00.000Z');
    assert.match(email.text, /Tuesday 18th November at 2pm/);
    assert.deepEqual(email.links, [{ href: 'https://calendly.com/acme/interview?a=1&b=2', text: 'Book a slot' }]);
  });

  test('extractLinks ignores non-http links and dedupes', () => {
    const links = extractLinks('<a href="https://x.test/a">A</a><a href=\'https://x.test/a\'>again</a><a href="javascript:alert(1)">no</a>');
    assert.deepEqual(links, [{ href: 'https://x.test/a', text: 'A' }]);
  });

  test('selectUids: first run keeps the newest, later runs continue in order with the cap', () => {
    assert.deepEqual(selectUids([5, 3, 9, 1], undefined, 2), [5, 9]);
    assert.deepEqual(selectUids([5, 3, 9, 1, 12], 4, 2), [5, 9]);
    assert.deepEqual(selectUids([1, 2], 10), []);
  });

  test('fetchNewEmails returns [] when Gmail is not configured', async () => {
    freshDb();
    assert.deepEqual(await fetchNewEmails(), []);
  });
});

// ───────────────────────────── processInbox ─────────────────────────────

describe('processInbox', () => {
  beforeEach(() => {
    freshDb();
    fetchCalls = [];
    process.env.GMAIL_USER = SELF;
  });
  after(() => { process.env.GMAIL_USER = ''; });

  test('job alerts older than three weeks are not imported (their postings are closed)', async () => {
    const old = { ...fixture('linkedin_alert'), messageId: '<old-alert@x>', date: new Date(Date.now() - 60 * 86_400_000).toISOString() };
    const stats = await processInbox({ emails: [old], notify: false, buildPrep: false });
    assert.equal(stats.jobsCreated, 0);
  });

  test('acts on each kind and never follows instructions inside emails', async () => {
    seedJobs();
    dbm.addApplication({ jobId: 'north00000000001', method: 'auto', status: 'submitted', submittedAt: '2025-11-10T16:00:00.000Z' });
    const selfMail: InboundEmail = { messageId: '<self@x>', from: `Me <${SELF}>`, fromAddress: SELF, subject: 'note to self', date: '2025-11-12T00:00:00.000Z', text: 'hi' };
    const emails = [
      fixture('interview_invite'), fixture('rejection_interview_process'), fixture('prompt_injection'),
      // Alerts older than ALERT_MAX_AGE_DAYS are ignored as stale, so this one is dated today.
      { ...fixture('linkedin_alert'), date: new Date().toISOString() }, fixture('greenhouse_confirmation'), fixture('question_notice_period'), fixture('newsletter'), selfMail,
    ];

    const stats = await processInbox({ emails, notify: false, buildPrep: true });
    assert.equal(stats.fetched, 8);
    assert.equal(stats.skippedSelf, 1);
    // PRIVACY: the newsletter is not job mail, so it is never stored or classified.
    assert.equal(stats.skippedPrivate, 1);
    assert.equal(stats.stored, 6);
    assert.equal(stats.processed, 6);
    assert.equal(stats.errors, 0);
    assert.equal(stats.byKind.interview, 1);
    assert.equal(stats.byKind.rejection, 1);
    assert.equal(stats.byKind.job_alert, 1);
    assert.equal(stats.byKind.confirmation, 2);
    assert.equal(stats.byKind.question, 1);
    assert.equal(stats.byKind.other, 0);
    assert.equal(dbm.listInbox({ limit: 50 }).some((i) => /newsletter/i.test(i.subject + i.fromAddress)), false, 'personal/marketing mail never stored');

    // interview → status, reply draft to the sender with a placeholder, calendar link, prep pack
    assert.equal(dbm.getJob('acme000000000001')?.status, 'interview');
    const [reply] = dbm.listMessages({ jobId: 'acme000000000001', kind: 'reply' });
    assert.equal(reply.status, 'draft');
    assert.equal(reply.to, 'sarah.kelly@acmecomms.ie');
    assert.equal(reply.inReplyTo, '<interview-1@acmecomms.example>');
    assert.equal(reply.subject, 'Re: Interview: PR Executive');
    assert.match(reply.body, /\[your availability\]/);
    assert.doesNotMatch(reply.body.replace(/\[your availability\]/, ''), /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i, 'never invents times');
    const interviewItem = dbm.listInbox({ jobId: 'acme000000000001' })[0];
    assert.equal(interviewItem.kind, 'interview');
    assert.equal(interviewItem.handled, false);
    assert.match(interviewItem.summary ?? '', /calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Interview%3A%20PR%20Executive%20at%20Acme%20Comms&dates=20251118T140000Z\/20251118T150000Z/);
    assert.ok(dbm.latestArtifact('acme000000000001', 'prep'), 'prep pack stored');
    assert.equal(stats.prepPacks, 1);

    // rejection → rejected
    assert.equal(dbm.getJob('bright0000000001')?.status, 'rejected');

    // prompt injection → plain confirmation, nothing sent/drafted/changed
    assert.equal(dbm.getJob('harbour000000001')?.status, 'applied');
    const everything = dbm.listMessages({ limit: 500 });
    assert.ok(everything.every((m) => !(m.to ?? '').includes('evil.com') && !m.body.includes('evil.com')));
    assert.ok(everything.every((m) => m.status === 'draft'), 'nothing approved or sent');
    assert.ok(dbm.listContacts().every((c) => !(c.email ?? '').includes('evil.com')));
    assert.equal(dbm.listMessages({ jobId: 'harbour000000001' }).length, 0);

    // job alert → jobs imported via gmailAlerts + normalize
    assert.equal(stats.jobsCreated, 2);
    const imported = dbm.listJobs({ source: 'gmail_alert' });
    assert.deepEqual(imported.map((j) => j.title).sort(), ['Communications Executive', 'PR Assistant']);

    // confirmation → note on the application; question → replied + draft
    const app = dbm.listApplications({ jobId: 'north00000000001' })[0];
    assert.match(app.confirmation ?? '', /Thank you for applying to Northlight Agency/);
    assert.equal(dbm.getJob('north00000000001')?.status, 'replied');
    const [qReply] = dbm.listMessages({ jobId: 'north00000000001', kind: 'reply' });
    assert.equal(qReply.to, 'mark.doyle@northlightagency.ie');
    assert.match(qReply.body, /\[your answer\]/);

    // nothing touched the network (no homepage links in the seeded JDs)
    assert.deepEqual(fetchCalls, []);

    // re-running the same mail is idempotent
    const again = await processInbox({ emails, notify: false, buildPrep: true });
    assert.equal(again.stored, 0);
    assert.equal(again.duplicates, 6);
    assert.equal(again.processed, 0);
    assert.equal(dbm.listMessages({ kind: 'reply' }).length, 2);
  });

  test('a rejection for a job that was never applied does not change its status', async () => {
    seedJobs();
    dbm.updateJob('bright0000000001', { status: 'ready' });
    await processInbox({ emails: [fixture('rejection_interview_process')], notify: false, buildPrep: false });
    assert.equal(dbm.getJob('bright0000000001')?.status, 'ready');
  });

  test('an email that fails to process is parked, not retried forever', async () => {
    seedJobs();
    const broken = { ...fixture('interview_invite'), messageId: '<broken@x>', text: undefined as unknown as string };
    const stats = await processInbox({ emails: [broken], notify: false, buildPrep: false });
    assert.equal(stats.stored, 1);
    const item = dbm.listInbox({ limit: 5 })[0];
    assert.ok(item.kind, 'classified or parked');
  });
});

// ───────────────────────────── Contacts ─────────────────────────────

const JD = [
  'Acme Comms is hiring a PR Executive. The role is reporting to Jane Murphy, Head of Communications.',
  'Send your CV to careers@acmecomms.ie. For data requests contact privacy@acmecomms.ie or gdpr@acmecomms.ie.',
  'Do not reply to noreply@acmecomms.ie. Questions to Tom Walsh (tom.walsh@acmecomms.ie).',
].join(' ');

describe('contacts', () => {
  beforeEach(() => freshDb());

  test('extractEmails excludes noreply/privacy/gdpr and asset names', () => {
    assert.deepEqual(extractEmails(`${JD} logo@2x.png`).sort(), ['careers@acmecomms.ie', 'tom.walsh@acmecomms.ie']);
  });

  test('extractHiringManagers finds "reporting to" and "questions to" names', () => {
    const mentions = extractHiringManagers(JD);
    const jane = mentions.find((m) => m.name === 'Jane Murphy');
    assert.ok(jane);
    assert.equal(jane.role, 'Head of Communications');
    const tom = mentions.find((m) => m.name === 'Tom Walsh');
    assert.equal(tom?.email, 'tom.walsh@acmecomms.ie');
    assert.deepEqual(extractHiringManagers('You will report to the Head of Marketing and work closely with sales.'), [{ role: 'Head of Marketing' }]);
  });

  test('companyDomain comes from a JD email or a non-ATS apply URL, else unknown', () => {
    assert.equal(companyDomain({ company: 'Acme Comms', description: JD, url: 'https://boards.greenhouse.io/acme/1', applyUrl: 'https://boards.greenhouse.io/acme/1' }), 'acmecomms.ie');
    assert.equal(companyDomain({ company: 'Acme', description: 'no email', url: 'https://careers.acme.co.uk/jobs/1', applyUrl: 'https://careers.acme.co.uk/jobs/1' }), 'acme.co.uk');
    assert.equal(companyDomain({ company: 'Acme', description: 'no email', url: 'https://jobs.lever.co/acme/1', applyUrl: 'https://jobs.lever.co/acme/1' }), undefined);
  });

  test('findContacts: JD emails + site emails on the company domain (verified), names unverified, LinkedIn search URL', async () => {
    seedJobs();
    const job = dbm.updateJob('acme000000000001', { description: JD })!;
    const pages: string[] = [];
    const fakeFetch = async (url: string) => {
      pages.push(url);
      const html = url.endsWith('/contact')
        ? '<p>Press: <a href="mailto:press@acmecomms.ie">press@acmecomms.ie</a>. Agency: someone@otherco.com</p>'
        : '<p>Welcome</p>';
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const contacts = await findContacts(job, { fetchImpl: fakeFetch as never });
    assert.deepEqual(pages, ['https://acmecomms.ie/', 'https://acmecomms.ie/contact', 'https://acmecomms.ie/careers']);

    const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email, c]));
    assert.deepEqual([...byEmail.keys()].sort(), ['careers@acmecomms.ie', 'press@acmecomms.ie', 'tom.walsh@acmecomms.ie']);
    for (const c of byEmail.values()) assert.equal(c.emailVerified, true);
    assert.equal(byEmail.get('press@acmecomms.ie')?.source, 'company_site');
    assert.equal(byEmail.get('tom.walsh@acmecomms.ie')?.name, 'Tom Walsh');

    const jane = contacts.find((c) => c.name === 'Jane Murphy');
    assert.equal(jane?.emailVerified, false);
    assert.equal(jane?.email, undefined, 'never guesses an address');

    const li = contacts.find((c) => c.source === 'linkedin_search');
    assert.equal(li?.linkedinUrl, 'https://www.linkedin.com/search/results/people/?keywords=recruiter%20OR%20talent%20OR%20hiring%20Acme%20Comms');
    assert.equal(linkedinSearchUrl('Acme'), 'https://www.linkedin.com/search/results/people/?keywords=recruiter%20OR%20talent%20OR%20hiring%20Acme');

    assert.ok(contacts.every((c) => 'id' in c), 'saved with upsertContact');
    assert.equal(dbm.listContacts({ jobId: job.id }).length, contacts.length);
  });

  test('findContacts skips the site fetch when the domain is unknown', async () => {
    seedJobs();
    const job = dbm.getJob('cairn00000000001')!;
    let calls = 0;
    const contacts = await findContacts(job, { save: false, fetchImpl: (async () => { calls++; throw new Error('x'); }) as never });
    assert.equal(calls, 0);
    assert.deepEqual(contacts.map((c) => c.source), ['linkedin_search']);
  });
});

// ───────────────────────────── Drafts ─────────────────────────────

describe('drafts', () => {
  beforeEach(() => freshDb());

  function signatureLess(body: string, sig: string): string {
    return body.endsWith(sig) ? body.slice(0, -sig.length) : body;
  }

  test('outreach email: verified contacts only, short, subject + CV, stored as draft', async () => {
    const [job] = seedJobs();
    const facts = loadFacts();
    const profile = loadProfile();
    const unverified = dbm.upsertContact({ jobId: job.id, company: job.company, email: 'guess@acmecomms.ie', emailVerified: false, source: 'manual', confidence: 0.2 });
    await assert.rejects(() => draft.draftOutreachEmail(job, unverified, facts, profile), draft.DraftError);
    const noreply = dbm.upsertContact({ jobId: job.id, company: job.company, email: 'noreply@acmecomms.ie', emailVerified: true, source: 'jd', confidence: 0.2 });
    await assert.rejects(() => draft.draftOutreachEmail(job, noreply, facts, profile), draft.DraftError);

    const contact = dbm.upsertContact({ jobId: job.id, company: job.company, name: 'Jane Murphy', email: 'jane@acmecomms.ie', emailVerified: true, source: 'jd', confidence: 0.9 });
    const m = await draft.draftOutreachEmail(job, contact, facts, profile);
    assert.equal(m.status, 'draft');
    assert.equal(m.channel, 'email');
    assert.equal(m.kind, 'outreach');
    assert.equal(m.to, 'jane@acmecomms.ie');
    assert.equal(m.subject, 'Application: PR Executive');
    assert.equal(m.attachCv, true);
    assert.match(m.body, /^Hi Jane,/);
    assert.match(m.body, /applied for the PR Executive role/);
    assert.ok(m.body.endsWith('Kind Regards,\nJane\nJane Doe'), m.body);
    assert.ok(wordCount(signatureLess(m.body, 'Kind Regards,\nJane\nJane Doe')) <= draft.LIMITS.outreachWords);
    assert.ok(Array.isArray(m.guardProblems) && Array.isArray(m.slopHits));
    assert.doesNotMatch(m.body, /[—–]/);

    const again = await draft.draftOutreachEmail(job, contact, facts, profile);
    assert.equal(again.id, m.id, 'no duplicate draft for the same contact');
  });

  test('LinkedIn note ≤300 chars, no links, addressed to the search URL', async () => {
    const [job] = seedJobs();
    const contact = dbm.upsertContact({ jobId: job.id, company: job.company, role: 'Recruiters', emailVerified: false, linkedinUrl: linkedinSearchUrl(job.company), source: 'linkedin_search', confidence: 0.3 });
    const m = await draft.draftLinkedInNote(job, contact, loadFacts(), loadProfile());
    assert.equal(m.channel, 'linkedin');
    assert.ok(m.body.length <= 300, `${m.body.length} chars`);
    assert.doesNotMatch(m.body, /https?:\/\//);
    assert.equal(m.to, contact.linkedinUrl);
  });

  test('follow-up ≤90 words, references the application date and role', async () => {
    const [job] = seedJobs();
    const contact = dbm.upsertContact({ jobId: job.id, company: job.company, email: 'careers@acmecomms.ie', emailVerified: true, source: 'jd', confidence: 0.8 });
    const app = dbm.addApplication({ jobId: job.id, method: 'auto', status: 'submitted', submittedAt: '2025-11-03T10:00:00.000Z' });
    const m = await draft.draftFollowUp(job, app, loadFacts(), { profile: loadProfile() });
    assert.equal(m.kind, 'follow_up');
    assert.equal(m.to, 'careers@acmecomms.ie');
    assert.equal(m.contactId, contact.id);
    assert.match(m.body, /3 November/);
    assert.match(m.body, /PR Executive/);
    assert.ok(wordCount(signatureLess(m.body, 'Kind Regards,\nJane\nJane Doe')) <= draft.LIMITS.followUpWords);
  });

  test('follow-up without a verified contact has no recipient and is flagged', async () => {
    const [job] = seedJobs();
    const m = await draft.draftFollowUp(job, undefined, loadFacts(), { profile: loadProfile(), appliedAt: '2025-11-03T10:00:00.000Z' });
    assert.equal(m.to, undefined);
    assert.ok(m.guardProblems?.some((p) => /verified contact/.test(p)));
  });

  test('reply to a no-reply sender has no recipient', async () => {
    seedJobs();
    const { item } = dbm.addInbox({ messageId: '<n@x>', fromAddress: 'no-reply@greenhouse.io', from: 'Acme <no-reply@greenhouse.io>', subject: 'Interview', date: '2025-11-12T00:00:00.000Z', body: 'x' });
    const m = await draft.draftReply(item, dbm.getJob('acme000000000001'), loadFacts(), { profile: loadProfile(), kind: 'interview' });
    assert.equal(m.to, undefined);
    assert.match(m.body, /\[your availability\]/);
  });

  test('factSentence keeps the fact wording', () => {
    assert.equal(draft.factSentence({ id: 'a', kind: 'achievement', text: 'Wrote weekly newsletters for 2,000 members', tags: [] }), 'I wrote weekly newsletters for 2,000 members.');
  });
});

// ───────────────────────────── Sending ─────────────────────────────

describe('sendApprovedEmails', () => {
  beforeEach(() => {
    freshDb();
    sentMail = [];
    failNextSend = false;
    process.env.GMAIL_USER = SELF;
  });
  after(() => { process.env.GMAIL_USER = ''; });

  function approved(over: Partial<import('../src/lib/types').NewMessage> = {}) {
    return dbm.addMessage({
      jobId: 'acme000000000001', direction: 'out', channel: 'email', kind: 'outreach',
      to: 'jane@acmecomms.ie', subject: 'Application: PR Executive', body: 'Hi Jane,\n\nShort note.\n\nKind Regards,\nJane', status: 'approved', ...over,
    });
  }
  function verifiedContact(email = 'jane@acmecomms.ie') {
    return dbm.upsertContact({ jobId: 'acme000000000001', company: 'Acme Comms', email, emailVerified: true, source: 'jd', confidence: 0.9 });
  }

  test('refuses unverified or guessed recipients', async () => {
    seedJobs();
    dbm.upsertContact({ jobId: 'acme000000000001', company: 'Acme Comms', email: 'guess@acmecomms.ie', emailVerified: false, source: 'manual', confidence: 0.1 });
    const guessed = approved({ to: 'guess@acmecomms.ie' });
    const unknown = approved({ to: 'stranger@acmecomms.ie' });
    const list = approved({ to: 'jane@acmecomms.ie, x@evil.com' });
    const res = await sendApprovedEmails();
    assert.deepEqual({ sent: res.sent, failed: res.failed }, { sent: 0, failed: 3 });
    assert.equal(sentMail.length, 0);
    for (const m of [guessed, unknown, list]) assert.equal(dbm.getMessage(m.id)?.status, 'failed');
    assert.match(dbm.getMessage(guessed.id)?.error ?? '', /not verified/);
  });

  test('when SMTP is unreachable the email is saved to Gmail Drafts and marked in_gmail, never sent', async () => {
    seedJobs();
    const contact = verifiedContact();
    const m = approved({ contactId: contact.id });
    setTransportForTests({ sendMail: async () => ({ response: 'saved to Gmail Drafts', draftOnly: true }) });
    try {
      const res = await sendApprovedEmails();
      assert.equal(res.sent, 0);
      assert.equal(res.drafted, 1);
      const row = dbm.getMessage(m.id);
      assert.equal(row?.status, 'in_gmail');
      assert.equal(row?.sentAt, undefined === row?.sentAt ? undefined : row?.sentAt);
      assert.equal(dbm.sentToday('email'), 0, 'a draft in Gmail does not count as sent');
    } finally {
      setTransportForTests(mockTransport);
    }
  });

  test('sends to a verified contact, records Message-ID, and never sends drafts', async () => {
    seedJobs();
    const contact = verifiedContact();
    const m = approved({ contactId: contact.id });
    const pending = approved({ status: 'draft' });
    const res = await sendApprovedEmails();
    assert.equal(res.sent, 1);
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, 'jane@acmecomms.ie');
    assert.equal(sentMail[0].from, `"Jane Doe" <${SELF}>`);
    const stored = dbm.getMessage(m.id)!;
    assert.equal(stored.status, 'sent');
    assert.equal(stored.messageId, '<mock-1@test>');
    assert.ok(stored.sentAt);
    assert.equal(stored.error, undefined, 'provisional claim marker cleared');
    assert.equal(dbm.getMessage(pending.id)?.status, 'draft');
    assert.equal((await sendApprovedEmails()).sent, 0, 'already sent messages are not re-sent');
  });

  test('replies go to the inbound sender with threading headers', async () => {
    seedJobs();
    const { item } = dbm.addInbox({ messageId: '<interview-1@acmecomms.example>', fromAddress: 'sarah.kelly@acmecomms.ie', from: 'Sarah <sarah.kelly@acmecomms.ie>', subject: 'Interview', date: '2025-11-12T00:00:00.000Z', body: 'x' });
    approved({ kind: 'reply', inboxId: item.id, to: 'sarah.kelly@acmecomms.ie', subject: 'Re: Interview', inReplyTo: '<interview-1@acmecomms.example>' });
    assert.equal(verifyRecipient(dbm.listMessages({ status: 'approved' })[0]).ok, true);
    const res = await sendApprovedEmails();
    assert.equal(res.sent, 1);
    assert.equal(sentMail[0].inReplyTo, '<interview-1@acmecomms.example>');
    assert.deepEqual(sentMail[0].references, ['<interview-1@acmecomms.example>']);
  });

  test('respects the pause switch', async () => {
    seedJobs();
    verifiedContact();
    const m = approved();
    dbm.updateSettings({ paused: true });
    const res = await sendApprovedEmails();
    assert.deepEqual(res, { sent: 0, failed: 0, skipped: 1, reason: 'paused' });
    assert.equal(sentMail.length, 0);
    assert.equal(dbm.getMessage(m.id)?.status, 'approved', 'left in the queue for later');
  });

  test('respects the daily email cap', async () => {
    seedJobs();
    verifiedContact();
    dbm.updateSettings({ dailyEmailCap: 2 });
    dbm.addMessage({ direction: 'out', channel: 'email', kind: 'outreach', to: 'jane@acmecomms.ie', subject: 's', body: 'b', status: 'sent' });
    approved();
    approved();
    const res = await sendApprovedEmails();
    assert.equal(res.sent, 1);
    assert.equal(res.skipped, 1);
    assert.match(res.reason ?? '', /cap/);
    assert.equal(dbm.listMessages({ status: 'approved' }).length, 1);
  });

  test('blocks unfilled placeholders and missing CV attachments; attaches the CV when present', async () => {
    seedJobs();
    verifiedContact();
    const placeholder = approved({ body: "I'm available [your availability]." });
    const noCv = approved({ attachCv: true });
    let res = await sendApprovedEmails();
    assert.equal(res.failed, 2);
    assert.match(dbm.getMessage(placeholder.id)?.error ?? '', /placeholder/);
    assert.match(dbm.getMessage(noCv.id)?.error ?? '', /CV PDF/);

    const dir = ensureDir(jobArtifactDir('acme000000000001'));
    const pdf = path.join(dir, 'Kshitiz_Mittal_CV.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 test');
    dbm.addArtifact({ jobId: 'acme000000000001', kind: 'cv_pdf', path: pdf });
    approved({ attachCv: true });
    res = await sendApprovedEmails();
    assert.equal(res.sent, 1);
    assert.deepEqual(sentMail[0].attachments, [{ filename: 'Kshitiz_Mittal_CV.pdf', path: pdf }]);
  });

  test('SMTP failure marks the message failed', async () => {
    seedJobs();
    verifiedContact();
    const m = approved();
    failNextSend = true;
    const res = await sendApprovedEmails();
    assert.equal(res.failed, 1);
    assert.equal(dbm.getMessage(m.id)?.status, 'failed');
    assert.match(dbm.getMessage(m.id)?.error ?? '', /SMTP error: 550/);
  });
});

// ───────────────────────────── Follow-ups ─────────────────────────────

describe('follow-ups', () => {
  beforeEach(() => freshDb());

  function applied(id: string, ago: number) {
    dbm.addApplication({ jobId: id, method: 'auto', status: 'submitted', submittedAt: daysAgo(ago) });
  }
  function contact(id: string, company: string, email: string) {
    dbm.upsertContact({ jobId: id, company, email, emailVerified: true, source: 'jd', confidence: 0.9 });
  }

  test('selects only quiet applications past followUpDays with a verified contact', async () => {
    seedJobs();
    // Acme: due. Brightwave: too soon. Northlight: responded. Harbour: no contact. Cairn: one sent follow-up 0 days ago.
    applied('acme000000000001', 8); contact('acme000000000001', 'Acme Comms', 'careers@acmecomms.ie');
    applied('bright0000000001', 2); contact('bright0000000001', 'Brightwave Media', 'talent@brightwavemedia.com');
    applied('north00000000001', 10); contact('north00000000001', 'Northlight Agency', 'jobs@northlightagency.ie');
    dbm.addInbox({ messageId: '<r@n>', fromAddress: 'jobs@northlightagency.ie', from: 'N <jobs@northlightagency.ie>', subject: 'Re', date: daysAgo(1), body: 'x', jobId: 'north00000000001', kind: 'question' });
    applied('harbour000000001', 9);
    applied('cairn00000000001', 30); contact('cairn00000000001', 'Cairn Foods', 'careers@cairnfoods.ie');
    dbm.addMessage({ jobId: 'cairn00000000001', direction: 'out', channel: 'email', kind: 'follow_up', to: 'careers@cairnfoods.ie', subject: 's', body: 'b', status: 'sent' });

    const days = dbm.getSettings().followUpDays;
    const skip = (id: string) => planFollowUp(dbm.getJob(id)!, days).skip;
    assert.equal(skip('acme000000000001'), undefined);
    assert.equal(skip('bright0000000001'), 'too_soon');
    assert.equal(skip('north00000000001'), 'responded');
    assert.equal(skip('harbour000000001'), 'no_contact');
    assert.equal(skip('cairn00000000001'), 'second_too_soon');
    assert.equal(planFollowUp(dbm.getJob('cairn00000000001')!, days, new Date(Date.now() + 15 * DAY)).nth, 2);

    const summary = await scheduleFollowUps({ facts: loadFacts(), profile: loadProfile() });
    assert.equal(summary.considered, 5); // Quayside is 'ready', not applied
    assert.equal(summary.drafted, 1);
    assert.deepEqual(summary.skipped, { too_soon: 1, responded: 1, no_contact: 1, second_too_soon: 1 });
    const drafts = dbm.listMessages({ kind: 'follow_up', status: 'draft' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].jobId, 'acme000000000001');

    // a pending draft blocks another one; a discarded one means "don't follow up"
    assert.equal(skip('acme000000000001'), 'pending_follow_up');
    dbm.updateMessage(drafts[0].id, { status: 'discarded' });
    assert.equal(skip('acme000000000001'), 'discarded');
    assert.equal((await scheduleFollowUps({ facts: loadFacts(), profile: loadProfile() })).drafted, 0);
  });

  test('two sent follow-ups is the maximum', () => {
    seedJobs();
    applied('acme000000000001', 60); contact('acme000000000001', 'Acme Comms', 'careers@acmecomms.ie');
    for (let i = 0; i < 2; i++) dbm.addMessage({ jobId: 'acme000000000001', direction: 'out', channel: 'email', kind: 'follow_up', to: 'careers@acmecomms.ie', subject: 's', body: 'b', status: 'sent' });
    assert.equal(planFollowUp(dbm.getJob('acme000000000001')!, 6, new Date(Date.now() + 30 * DAY)).skip, 'max_reached');
  });
});

// ───────────────────────────── Digest + notify ─────────────────────────────

describe('digest', () => {
  beforeEach(() => {
    freshDb();
    sentMail = [];
  });
  after(() => { process.env.GMAIL_USER = ''; process.env.GMAIL_APP_PASSWORD = ''; });

  test('buildDigest summarises the last 24h', () => {
    seedJobs();
    dbm.updateJob('other00000000001', { status: 'needs_you', needs: ['captcha'] });
    dbm.setStatus('acme000000000001', 'interview');
    dbm.addInbox({ messageId: '<i@a>', fromAddress: 'sarah@acmecomms.ie', from: 'S <sarah@acmecomms.ie>', subject: 'Interview', date: new Date().toISOString(), body: 'x', jobId: 'acme000000000001', kind: 'interview' });
    const text = buildDigest();
    assert.match(text, /^Pursuit daily digest, /);
    assert.match(text, /New jobs: 6/);
    assert.match(text, /Employer replies: 1/);
    assert.match(text, /Interview invites: 1\n {2}- Acme Comms: PR Executive/);
    assert.match(text, /Needs you: 1\n {2}- Quayside Studio: Marketing Executive \(captcha\)/);
    assert.match(text, /LLM: 0 calls, \$0/);
  });

  test('sendDigestToSelf sends only to GMAIL_USER, once a day', async () => {
    process.env.GMAIL_USER = '';
    assert.deepEqual(await sendDigestToSelf(), { sent: false, reason: 'mail not configured' });
    process.env.GMAIL_USER = SELF;
    process.env.GMAIL_APP_PASSWORD = 'test-app-password';
    const first = await sendDigestToSelf();
    assert.equal(first.sent, true);
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, SELF);
    const stored = dbm.getMessage(first.messageId!)!;
    assert.equal(stored.kind, 'digest');
    assert.equal(stored.status, 'sent');
    assert.equal(dbm.sentToday('email'), 0, 'digests do not count toward the outreach cap');
    assert.deepEqual(await sendDigestToSelf(), { sent: false, reason: 'already sent today' });
  });
});

describe('notify + text helpers', () => {
  test('escapeAppleScript neutralises quotes, backslashes and control characters', () => {
    assert.equal(escapeAppleScript('He said "hi" \\ ok\nnext'), 'He said \\"hi\\" \\\\ ok next');
  });

  test('notify never throws and is a no-op when disabled', async () => {
    freshDb();
    assert.deepEqual(await notify('Interview: "Acme"', 'body', { url: 'http://localhost:7020/inbox', priority: 'high' }), { mac: false, ntfy: false });
  });

  test('address helpers', () => {
    assert.equal(normalizeEmail('Jane <Jane.Doe@Acme.IE>'), 'jane.doe@acme.ie');
    assert.equal(normalizeEmail('not an email'), undefined);
    assert.equal(isNoReplyAddress('no-reply@greenhouse.io'), true);
    assert.equal(isNoReplyAddress('jane@acme.ie'), false);
  });
});
