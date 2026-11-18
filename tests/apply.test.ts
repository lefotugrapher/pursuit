// Apply-runner tests (SPEC §5.5, §0.10): pure helpers, runner guards, and full browser runs against
// local fixture pages served from 127.0.0.1. Requests to any other host are aborted, the DB, data dir,
// config and Chrome profile are temp dirs, and the CV is a dummy PDF in /private/tmp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'apply');
const REPO_CONFIG = path.join(HERE, '..', 'config');

const TMP = fs.mkdtempSync(path.join(fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir(), 'pursuit-apply-test-'));
const DATA_DIR = path.join(TMP, 'data');
const CONFIG_DIR = path.join(TMP, 'config');
const PROFILE_DIR = path.join(TMP, 'chrome-profile');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
process.env.PURSUIT_DATA_DIR = DATA_DIR;
process.env.PURSUIT_CONFIG_DIR = CONFIG_DIR;
process.env.PURSUIT_DB_PATH = path.join(TMP, 'boot.db');

// Fake identity (the example profile), never Kayzee's real one.
fs.copyFileSync(path.join(REPO_CONFIG, 'profile.example.json'), path.join(CONFIG_DIR, 'profile.json'));
fs.writeFileSync(path.join(CONFIG_DIR, 'answers.json'), JSON.stringify({
  entries: [
    { id: 'heard-about', patterns: ['how did you hear', 'how you heard'], answer: 'LinkedIn', type: 'select' },
    { id: 'salary-unconfirmed', patterns: ['salary expectation'], answer: '40000', type: 'number', confirm: true },
  ],
}));

const CV_PATH = path.join(TMP, 'Jane_Doe_CV.pdf');
fs.writeFileSync(CV_PATH, [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n'));
const COVER_TEXT = 'Hi,\n\nI would like to apply for this role.\n\nKind Regards,\nJane';

const dbm = await import('../src/lib/db');
const runner = await import('../src/engine/apply/runner');
const detect = await import('../src/engine/apply/detect');
const confirm = await import('../src/engine/apply/confirm');
const fields = await import('../src/engine/apply/fields');
const browser = await import('../src/engine/apply/browser');
type NewJob = import('../src/lib/types').NewJob;
type AnsweredQuestion = import('../src/lib/types').AnsweredQuestion;
type RawField = import('../src/engine/apply/inpage').RawField;

// ───────────────────────────── Fixture server ─────────────────────────────

const ROUTES: Record<string, string> = {
  '/_harness.js': '_harness.js',
  '/greenhouse/acme/jobs/4012345': 'greenhouse_form.html',
  '/greenhouse/acme/jobs/4012345/confirmation': 'greenhouse_confirmation.html',
  '/lever/acme/5ac2e1b0-1111-4a2b-9c3d-000000000001/apply': 'lever_form.html',
  '/lever/acme/5ac2e1b0-1111-4a2b-9c3d-000000000001/thanks': 'lever_thanks.html',
  '/lever/acme/5ac2e1b0-2222-4a2b-9c3d-000000000002/apply': 'captcha_form.html',
  '/ashby/acme/0b6f3c1e-3333-4d5e-8f90-000000000003/application': 'ashby_form.html',
};

const submissions: Record<string, Record<string, unknown>[]> = {};
let server: http.Server;
let BASE = '';

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname.startsWith('/__submit/')) {
      const name = decodeURIComponent(url.pathname.slice('/__submit/'.length));
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      req.on('end', () => {
        (submissions[name] ??= []).push(JSON.parse(body || '{}') as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
      return;
    }
    const file = ROUTES[url.pathname];
    if (req.method !== 'GET' || !file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const type = file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(path.join(FIXTURES, file)));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

const RUN = { profileDir: PROFILE_DIR, allowHosts: ['127.0.0.1'] };

// ───────────────────────────── Seeding ─────────────────────────────

let dbCounter = 0;
function freshDb(): void {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `t${++dbCounter}.db`);
  for (const k of Object.keys(submissions)) delete submissions[k];
}

let jobCounter = 0;
function seedJob(over: Partial<NewJob>, opts: { answers?: AnsweredQuestion[]; cv?: string | null; status?: 'approved' | 'ready' } = {}): string {
  const id = `applytest${String(++jobCounter).padStart(7, '0')}`;
  const url = over.url ?? `${BASE}/greenhouse/acme/jobs/4012345`;
  const job: NewJob = {
    id,
    source: 'greenhouse',
    sourceId: id,
    company: 'Acme Comms',
    title: `PR Executive ${jobCounter}`,
    location: 'Dublin, Ireland',
    country: 'IE',
    remote: false,
    url,
    applyUrl: url,
    ats: 'greenhouse',
    atsMeta: {},
    description: 'Fixture job.',
    ...over,
  };
  dbm.upsertJob(job);
  dbm.setStatus(id, opts.status ?? 'approved');
  if (opts.cv !== null) dbm.addArtifact({ jobId: id, kind: 'cv_pdf', path: opts.cv ?? CV_PATH, meta: { summaryVariant: 'pr' } });
  dbm.addArtifact({ jobId: id, kind: 'cover_letter', content: COVER_TEXT });
  dbm.addArtifact({ jobId: id, kind: 'answers', content: JSON.stringify(opts.answers ?? []) });
  return id;
}

function aq(id: string, label: string, answer: string | null, type: AnsweredQuestion['type'] = 'text', required = true): AnsweredQuestion {
  return { id, label, type, required, answer, source: answer === null ? 'none' : 'bank', needsHuman: answer === null };
}

const GH_ANSWERS: AnsweredQuestion[] = [
  aq('question_1001', 'Are you authorised to work in the country in which this role is located?', 'Yes', 'select'),
  aq('question_1002', 'Current or most recent company?', 'Example Students Union'),
  aq('question_1005', 'What excites you most about this opportunity?', 'The mix of media relations and community work.', 'textarea', false),
  aq('question_1007', 'Please email me about future job openings', 'No', 'select'),
  aq('question_1008', 'I consent to Acme Comms processing my personal data for this application, as described in the privacy notice', 'Yes', 'checkbox'),
];

const LEVER_ANSWERS: AnsweredQuestion[] = [
  aq('cards[1c719ca9-5069-4afe-9e82-39ca420e0edb][field0]', 'Are you legally authorized to work in the country for which you are applying?', 'Yes', 'radio'),
  aq('cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', 'Language Skill(s) (Check all that apply)', 'English, Hindi', 'checkbox'),
];

const ASHBY_LABEL_CAMPAIGN = "Describe a campaign you'd pitch for our spring launch";
const ASHBY_ANSWERS: AnsweredQuestion[] = [
  aq('4f0a2b9e-auth', 'Are you legally authorised to work in Ireland?', 'Yes', 'yesno'),
  aq('7c1d3e5f-relocate', 'Are you willing to work from our Dublin office three days a week?', 'Yes', 'yesno'),
];

function eventTypes(jobId: string): string[] {
  return dbm.listEvents({ jobId, limit: 500 }).map((e) => e.type);
}

function last(name: string): Record<string, unknown> {
  const list = submissions[name] ?? [];
  assert.ok(list.length > 0, `expected a recorded ${name} submission`);
  return list[list.length - 1];
}

before(startServer);
beforeEach(freshDb);
after(async () => {
  await browser.closeAllBrowsers();
  await new Promise<void>((r) => server.close(() => r()));
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── Pure helpers ─────────────────────────────

describe('detectAts', () => {
  test('maps hosts to ATS kinds', () => {
    assert.equal(detect.detectAts('https://job-boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
    assert.equal(detect.detectAts('https://boards.greenhouse.io/embed/job_app?for=acme&token=1'), 'greenhouse');
    assert.equal(detect.detectAts('https://careers.acme.ie/jobs?gh_jid=4012345'), 'greenhouse');
    assert.equal(detect.detectAts('https://jobs.lever.co/acme/abc/apply'), 'lever');
    assert.equal(detect.detectAts('https://jobs.ashbyhq.com/acme/uuid/application'), 'ashby');
    assert.equal(detect.detectAts('https://jobs.smartrecruiters.com/Acme/123'), 'smartrecruiters');
    assert.equal(detect.detectAts('https://apply.workable.com/acme/j/ABC/'), 'workable');
    assert.equal(detect.detectAts('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x'), 'workday');
    assert.equal(detect.detectAts('https://www.linkedin.com/jobs/view/123'), 'linkedin');
    assert.equal(detect.detectAts('https://ie.indeed.com/viewjob?jk=1'), 'indeed');
    assert.equal(detect.detectAts('mailto:jobs@acme.ie'), 'email');
    assert.equal(detect.detectAts('https://acme.ie/careers'), 'unknown');
    assert.equal(detect.detectAts('not a url'), 'unknown');
  });
});

describe('blockersFromFacts', () => {
  const base = { url: 'x', title: '', text: '', captchaVisible: [], captchaPassive: [], passwordFields: 0, hasFormControls: 10 };

  test('a visible captcha blocks; a passive one does not', () => {
    assert.deepEqual(detect.blockersFromFacts({ ...base, captchaVisible: ['div.h-captcha'] }).blockers, ['captcha']);
    const passive = detect.blockersFromFacts({ ...base, captchaPassive: ['div.h-captcha'] });
    assert.deepEqual(passive.blockers, []);
    assert.deepEqual(passive.passiveCaptcha, ['div.h-captcha']);
  });

  test('login walls, account walls, bot checks and closed postings', () => {
    assert.ok(detect.blockersFromFacts({ ...base, text: 'Sign in to apply for this job' }).blockers.includes('login'));
    assert.ok(detect.blockersFromFacts({ ...base, passwordFields: 1 }).blockers.includes('login'));
    assert.ok(detect.blockersFromFacts({ ...base, passwordFields: 2, text: 'Create an account' }).blockers.includes('account_required'));
    assert.ok(detect.blockersFromFacts({ ...base, text: 'Create an account to apply', hasFormControls: 2 }).blockers.includes('account_required'));
    assert.ok(detect.blockersFromFacts({ ...base, text: 'Please verify you are a human' }).blockers.includes('captcha'));
    assert.ok(detect.blockersFromFacts({ ...base, text: 'This company is no longer accepting applications for this role' }).blockers.includes('closed'));
    assert.ok(detect.blockersFromFacts({ ...base, text: 'Sorry, this position has been filled.' }).blockers.includes('closed'));
    assert.deepEqual(detect.blockersFromFacts({ ...base, text: 'Apply for this job. First name, Last name.' }).blockers, []);
  });
});

describe('matchConfirmation', () => {
  test('matches success text and confirmation URLs', () => {
    for (const t of ['Thank you for applying!', 'Thanks for applying to Acme', 'Your application has been submitted.', 'Application submitted!', 'Your application has been received', 'We have received your application', "We've received your application"]) {
      assert.equal(confirm.matchConfirmation(t, 'https://x.test/apply').confirmed, true, t);
    }
    assert.equal(confirm.matchConfirmation('', 'https://job-boards.greenhouse.io/acme/jobs/1/confirmation', { startUrl: 'https://job-boards.greenhouse.io/acme/jobs/1' }).confirmed, true);
    assert.equal(confirm.matchConfirmation('', 'https://jobs.lever.co/acme/1/thanks', { startUrl: 'https://jobs.lever.co/acme/1/apply' }).confirmed, true);
    assert.equal(confirm.matchConfirmation('Please fix the errors below', 'https://x.test/apply', { startUrl: 'https://x.test/apply' }).confirmed, false);
  });

  test('text already on the page before submit does not count', () => {
    const r = confirm.matchConfirmation('Thank you for applying to our programme.', 'https://x.test/apply', {
      startUrl: 'https://x.test/apply',
      baselinePatterns: confirm.matchedPatterns('Thank you for applying to our programme.'),
    });
    assert.equal(r.confirmed, false);
  });
});

describe('field helpers', () => {
  test('bestOption picks confident matches only', () => {
    assert.equal(fields.bestOption('Ireland', ['United Kingdom +44', 'Ireland +353'])?.index, 1);
    assert.equal(fields.bestOption('Yes', ['No', 'Yes, I am authorised'])?.index, 1);
    assert.equal(fields.bestOption('LinkedIn', ['Company website', 'LinkedIn', 'Other'])?.index, 1);
    assert.equal(fields.bestOption('Banana', ['Yes', 'No']), null);
  });

  test('findDeclineOption finds every common decline wording', () => {
    assert.equal(fields.findDeclineOption(['Male', 'Female', 'Decline To Self Identify']), 2);
    assert.equal(fields.findDeclineOption(['I am not a protected veteran', "I don't wish to answer"]), 1);
    assert.equal(fields.findDeclineOption(['Yes, I have a disability', 'No', 'I do not want to answer']), 2);
    assert.equal(fields.findDeclineOption(['Prefer not to say', 'Woman']), 0);
    assert.equal(fields.findDeclineOption(['Male', 'Female']), -1);
  });

  test('standardKind maps profile fields strictly', () => {
    const f = (over: Partial<RawField>): RawField => ({
      idx: 0, kind: 'text', label: '', rawLabel: '', required: false, options: [], optionDomIndex: [], name: '', id: '', type: 'text',
      autocomplete: '', placeholder: '', hasValue: false, eeoSection: false, hasManualToggle: false, ...over,
    });
    assert.equal(fields.standardKind(f({ label: 'First Name', autocomplete: 'given-name' })), 'first');
    assert.equal(fields.standardKind(f({ label: 'Full name', name: 'name' }), 'lever'), 'full');
    assert.equal(fields.standardKind(f({ label: 'Email', id: 'email' })), 'email');
    assert.equal(fields.standardKind(f({ label: 'LinkedIn URL', name: 'urls[LinkedIn]' })), 'linkedin');
    assert.equal(fields.standardKind(f({ kind: 'file', label: 'Resume/CV', id: 'resume' })), 'cv');
    assert.equal(fields.standardKind(f({ kind: 'file', label: 'Cover Letter', id: 'cover_letter' })), 'cover_file');
    assert.equal(fields.standardKind(f({ kind: 'textarea', label: 'Additional information', name: 'comments' }), 'lever'), 'cover_text');
    assert.equal(fields.standardKind(f({ kind: 'combobox', label: 'Country', id: 'country' })), 'country');
    assert.equal(fields.standardKind(f({ label: 'Current or most recent company?' })), null);
    assert.equal(fields.standardKind(f({ label: 'Email me about marketing updates', kind: 'email' })), null);
  });

  test('EEO and attestation labels are recognised', () => {
    assert.equal(fields.isEeoLabel('Are you Hispanic/Latino?'), true);
    assert.equal(fields.isEeoLabel('Veteran Status'), true);
    assert.equal(fields.isEeoLabel('Current or most recent company?'), false);
    assert.equal(fields.isAttestationLabel('I certify that the information provided is true and complete'), true);
    assert.equal(fields.isAttestationLabel('Are you willing to relocate?'), false);
  });

  test('unconfirmed answer-bank entries are never used', () => {
    const bank = { entries: [
      { id: 'a', patterns: ['salary expectation'], answer: '40000', confirm: true },
      { id: 'b', patterns: ['how did you hear'], answer: 'LinkedIn' },
    ] };
    assert.equal(fields.matchBankEntry('What are your salary expectations?', bank), null);
    assert.equal(fields.matchBankEntry('How did you hear about this job?', bank)?.id, 'b');
  });
});

describe('runner helpers', () => {
  test('normalises titles and companies for duplicate checks', () => {
    assert.equal(runner.normalizeTitle('PR Executive (m/f/d)'), 'pr executive');
    assert.equal(runner.normalizeTitle('Comms & PR Executive [Dublin]'), 'comms and pr executive');
    assert.equal(runner.normalizeCompany('Acme Comms Ltd.'), 'acme comms');
    assert.equal(runner.normalizeCompany('Acme Comms Limited'), 'acme comms');
  });

  test('parseAnswersArtifact accepts arrays and {answers}, drops junk', () => {
    const one = runner.parseAnswersArtifact(JSON.stringify([{ id: 'q', label: 'Q?', answer: 'Yes' }, { nope: 1 }]));
    assert.equal(one.length, 1);
    assert.equal(one[0].needsHuman, false);
    const two = runner.parseAnswersArtifact(JSON.stringify({ answers: [{ id: 'q', label: 'Q?', answer: null }] }));
    assert.equal(two[0].needsHuman, true);
    assert.deepEqual(runner.parseAnswersArtifact('not json'), []);
  });
});

// ───────────────────────────── Guards (no browser) ─────────────────────────────

describe('applyToJob guards', () => {
  test('paused → skipped, no application row', async () => {
    const id = seedJob({});
    dbm.updateSettings({ paused: true });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'skipped');
    assert.match(out.needs?.[0] ?? '', /paused/i);
    assert.equal(dbm.listApplications({ jobId: id }).length, 0);
    assert.equal(dbm.getJob(id)?.status, 'approved');
  });

  test('daily cap reached → skipped', async () => {
    const done = seedJob({ company: 'Other Co', title: 'Marketing Assistant' });
    dbm.addApplication({ jobId: done, method: 'auto', status: 'submitted' });
    dbm.setStatus(done, 'applied');
    dbm.updateSettings({ dailyApplyCap: 1 });
    const id = seedJob({});
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'skipped');
    assert.match(out.needs?.[0] ?? '', /cap/i);
  });

  test('same company + normalised title applied within 60 days → skipped', async () => {
    const first = seedJob({ company: 'Acme Comms Ltd', title: 'PR Executive (Dublin)', location: 'Dublin' });
    dbm.addApplication({ jobId: first, method: 'auto', status: 'submitted' });
    dbm.setStatus(first, 'applied');
    const second = seedJob({ company: 'Acme Comms', title: 'PR Executive', location: 'Dublin, Ireland' });
    const out = await runner.applyToJob(second, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'skipped');
    assert.match(out.needs?.[0] ?? '', /already applied/i);
    assert.equal(dbm.getJob(second)?.status, 'skipped');
  });

  test('missing CV PDF → failed with a need', async () => {
    const id = seedJob({}, { cv: null });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'failed');
    assert.match(out.needs?.join(' ') ?? '', /CV PDF missing/);
    assert.equal(dbm.getJob(id)?.status, 'failed');
    assert.equal(dbm.listApplications({ jobId: id }).length, 0);
  });

  test('not approved → never submits', async () => {
    const id = seedJob({}, { status: 'ready' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'skipped');
    assert.equal(dbm.getJob(id)?.status, 'ready');
  });

  test('LinkedIn postings are never driven: skipped until resolved to an employer site', async () => {
    // Behaviour change (Nov 2026): was needs_you; now skipped so the resolver can supply the employer URL.
    const id = seedJob({ url: 'https://www.linkedin.com/jobs/view/123', ats: 'linkedin', source: 'linkedin_guest' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'skipped');
    assert.deepEqual(out.needs, [runner.NEED_NOT_RESOLVED]);
    assert.equal(dbm.listApplications({ jobId: id }).length, 0);
    assert.equal(dbm.getJob(id)?.status, 'approved', 'stays in the queue for the resolver');
  });
});

// ───────────────────────────── Browser runs against fixtures ─────────────────────────────

describe('applyToJob against fixtures', { timeout: 240_000 }, () => {
  test('greenhouse: fills everything, declines EEO, submits, confirms, screenshots', async () => {
    const id = seedJob({}, { answers: GH_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /thank you for applying|confirmation/i);
    assert.ok(out.screenshotPath && fs.existsSync(out.screenshotPath), 'screenshot saved');
    assert.ok(out.screenshotPath.startsWith(path.join(DATA_DIR, 'screenshots')));

    const sent = last('greenhouse');
    assert.equal(sent.first_name, 'Jane');
    assert.equal(sent.last_name, 'Doe');
    assert.equal(sent.email, 'jane.doe@example.com');
    assert.equal(sent.phone, '+353 1 555 0100');
    assert.equal(sent.country, 'Ireland +353');
    assert.deepEqual(sent.resume, [{ name: path.basename(CV_PATH), size: fs.statSync(CV_PATH).size }]);
    assert.equal(sent.cover_letter_text, COVER_TEXT);
    assert.equal(sent.question_1001, 'Yes');
    assert.equal(sent.question_1002, 'Example Students Union');
    assert.equal(sent.question_1003, 'https://www.linkedin.com/in/jane-doe-example');
    assert.equal(sent.question_1004, 'https://portfolio.example.com');
    assert.equal(sent.question_1005, 'The mix of media relations and community work.');
    assert.equal(sent.question_1006, '2', 'native select answered from the confirmed bank entry (LinkedIn)');
    assert.equal(sent.question_1007, 'No');
    assert.deepEqual(sent.question_1008, ['1']);
    assert.equal(sent.gender, 'Decline To Self Identify');
    assert.equal(sent.hispanic_ethnicity, 'Decline To Self Identify');
    assert.equal(sent.veteran_status, "I don't wish to answer");
    assert.equal(sent.disability_status, '3');
    assert.equal(sent['candidate-location'], '', 'optional city search left alone');

    const job = dbm.getJob(id);
    assert.equal(job?.status, 'applied');
    const apps = dbm.listApplications({ jobId: id });
    assert.equal(apps.length, 1);
    assert.equal(apps[0].status, 'submitted');
    assert.equal(apps[0].screenshotPath, out.screenshotPath);
    assert.ok(apps[0].submittedAt);
    assert.equal(dbm.latestArtifact(id, 'screenshot')?.path, out.screenshotPath);
    const types = eventTypes(id);
    for (const t of ['apply.start', 'apply.filled', 'apply.submitted', 'apply.confirmed']) assert.ok(types.includes(t), `event ${t}`);

    const seen = (job?.atsMeta.questionsSeen ?? []) as { id: string; label: string; required: boolean; options?: string[] }[];
    const q1001 = seen.find((q) => q.id === 'question_1001');
    assert.ok(q1001, 'questionsSeen records custom questions');
    assert.equal(q1001.required, true);
    assert.ok(!seen.some((q) => q.id === 'first_name'), 'standard profile fields are not questions');
    assert.ok(seen.some((q) => /hear about/i.test(q.label) && q.options?.includes('LinkedIn')));
    assert.equal(seen.find((q) => q.id === 'question_1008')?.label.startsWith('I consent to Acme Comms'), true, 'checkbox gets its own label');
  });

  test('greenhouse: submit accepted but no success state → needs_you, never applied', async () => {
    const url = `${BASE}/greenhouse/acme/jobs/4012345?noconfirm=1`;
    const id = seedJob({ url, applyUrl: url }, { answers: GH_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, confirmTimeoutMs: 2_500, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.needs, [runner.NEED_NO_CONFIRMATION]);
    assert.equal(submissions.greenhouse?.length, 1, 'the form did go out');
    assert.equal(dbm.getJob(id)?.status, 'needs_you');
    assert.equal(dbm.listApplications({ jobId: id })[0].status, 'needs_you');
    assert.ok(!eventTypes(id).includes('apply.confirmed'));
  });

  test('greenhouse fill-only: fills, does not submit, asks for review', async () => {
    const id = seedJob({}, { answers: GH_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'fill-only', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you');
    assert.deepEqual(out.needs, [runner.NEED_REVIEW_AND_SUBMIT]);
    assert.equal(submissions.greenhouse, undefined);
  });

  test('greenhouse without an approved consent answer → needs_you for the attestation', async () => {
    const id = seedJob({}, { answers: GH_ANSWERS.filter((q) => q.id !== 'question_1008') });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you');
    assert.ok(out.needs?.some((n) => /attestation/i.test(n) && /I consent to Acme Comms/.test(n)), JSON.stringify(out.needs));
    assert.equal(submissions.greenhouse, undefined);
  });

  test('lever: waits for resume parsing, multi-select, bank dropdown, EEO decline, submits', async () => {
    const url = `${BASE}/lever/acme/5ac2e1b0-1111-4a2b-9c3d-000000000001`;
    const id = seedJob({ url, applyUrl: url, ats: 'lever', source: 'lever', title: 'Communications Executive' }, { answers: LEVER_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /application submitted|thanks/i);

    const sent = last('lever');
    assert.equal(sent.name, 'Jane Doe', 'profile name replaces the parser pre-fill');
    assert.equal(sent.email, 'jane.doe@example.com');
    assert.equal(sent.location, 'Exampletown, Co. Example, Ireland');
    assert.equal(sent['urls[LinkedIn]'], 'https://www.linkedin.com/in/jane-doe-example');
    assert.equal(sent['urls[Portfolio]'], 'https://portfolio.example.com');
    assert.deepEqual(sent.resume, [{ name: path.basename(CV_PATH), size: fs.statSync(CV_PATH).size }]);
    assert.equal(sent['cards[1c719ca9-5069-4afe-9e82-39ca420e0edb][field0]'], 'Yes');
    assert.deepEqual(sent['cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]'], ['English (ENG)', 'Hindi (HIN)']);
    assert.equal(sent['cards[a6197d84-549e-4a91-8bb0-6af972510013][field0]'], 'LinkedIn');
    assert.equal(sent['eeo[gender]'], 'Decline to self-identify');
    assert.equal(sent['eeo[race]'], 'Decline to self-identify');
    assert.equal(sent['eeo[veteran]'], 'Decline to self-identify');
    assert.equal(sent.comments, COVER_TEXT);
    assert.equal(sent.org, '', 'optional unknown field left empty');
    assert.equal(dbm.getJob(id)?.status, 'applied');
  });

  test('lever with a visible hCaptcha → needs_you, submit never clicked', async () => {
    const url = `${BASE}/lever/acme/5ac2e1b0-2222-4a2b-9c3d-000000000002/apply`;
    const id = seedJob({ url, applyUrl: url, ats: 'lever', source: 'lever', title: 'Social Media Executive' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.needs?.some((n) => /captcha/i.test(n)));
    assert.equal(submissions.captcha, undefined, 'submit was never clicked');
    assert.equal(dbm.getJob(id)?.status, 'needs_you');
    assert.deepEqual(dbm.getJob(id)?.needs, out.needs);
    assert.ok(eventTypes(id).includes('apply.blocker'));
    assert.equal(dbm.listApplications({ jobId: id })[0].status, 'needs_you');
  });

  test('ashby: unknown required question → needs_you listing the label, nothing submitted', async () => {
    const url = `${BASE}/ashby/acme/0b6f3c1e-3333-4d5e-8f90-000000000003/application`;
    const id = seedJob({ url, applyUrl: url, ats: 'ashby', source: 'ashby', title: 'Content & Community Executive' }, { answers: ASHBY_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.needs?.some((n) => n.includes(ASHBY_LABEL_CAMPAIGN)), JSON.stringify(out.needs));
    assert.equal(out.needs?.length, 1, 'only the unknown question is outstanding (passive reCAPTCHA is not a blocker)');
    assert.equal(submissions.ashby, undefined);
    const seen = (dbm.getJob(id)?.atsMeta.questionsSeen ?? []) as { label: string; type: string; required: boolean }[];
    assert.ok(seen.some((q) => q.label === ASHBY_LABEL_CAMPAIGN && q.type === 'textarea' && q.required));
    assert.ok(seen.some((q) => q.type === 'yesno' && /authorised to work/.test(q.label)));
  });

  test('ashby: fully answered → submits and confirms via the in-place success container', async () => {
    const url = `${BASE}/ashby/acme/0b6f3c1e-3333-4d5e-8f90-000000000003/application`;
    const answers = [...ASHBY_ANSWERS, aq('9a8b7c6d-campaign', ASHBY_LABEL_CAMPAIGN, 'A student-led launch week with short-form video.', 'textarea')];
    const id = seedJob({ url, applyUrl: url, ats: 'ashby', source: 'ashby', title: 'Content Executive' }, { answers });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /success-container|thank you/i);
    const sent = last('ashby');
    assert.equal(sent._systemfield_name, 'Jane Doe');
    assert.equal(sent._systemfield_email, 'jane.doe@example.com');
    assert.deepEqual(sent._systemfield_resume, [{ name: path.basename(CV_PATH), size: fs.statSync(CV_PATH).size }]);
    assert.equal(sent['4f0a2b9e-auth'], 'Yes');
    assert.equal(sent['7c1d3e5f-relocate'], 'Yes');
    assert.equal(sent['b7e1c2a4-linkedin'], 'https://www.linkedin.com/in/jane-doe-example');
  });

  test('openForHandoff pre-fills and never submits', async () => {
    const id = seedJob({}, { answers: GH_ANSWERS });
    const out = await runner.openForHandoff(id, { headless: true, ...RUN });
    assert.equal(out.status, 'needs_you');
    assert.match(out.needs?.[0] ?? '', /submit it yourself/);
    assert.equal(submissions.greenhouse, undefined);
    assert.equal(dbm.getJob(id)?.status, 'needs_you');
    assert.ok(eventTypes(id).includes('apply.handoff'));
  });

  test('scanQuestions lists custom questions with combobox options, without filling', async () => {
    const qs = await browser.withBrowser({ headless: true, ...RUN }, async (page) => {
      await page.goto(`${BASE}/greenhouse/acme/jobs/4012345`);
      return runner.scanQuestions(page, 'greenhouse');
    });
    const auth = qs.find((q) => q.id === 'question_1001');
    assert.deepEqual(auth?.options, ['Yes', 'No']);
    assert.equal(auth?.type, 'yesno');
    assert.ok(qs.some((q) => q.id === 'gender' && q.options?.includes('Decline To Self Identify')));
    assert.ok(!qs.some((q) => q.id === 'email'));
    assert.equal(submissions.greenhouse, undefined);
  });
});
