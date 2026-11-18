// Apply engine v2 tests: SmartRecruiters, Workable and the universal (LLM-assisted) filler, account
// walls, CAPTCHA/bot walls, consent rules, LinkedIn/Indeed skipping, Greenhouse embeds and the browser
// launch config. Everything runs against local fixtures on 127.0.0.1; requests to any other host are
// aborted, the DB/data/config/Chrome profile are temp dirs, and no LLM is ever called (a fake mapper
// is injected where the LLM path is under test).

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

const TMP = fs.mkdtempSync(path.join(fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir(), 'pursuit-apply-ats-'));
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
process.env.OPENROUTER_API_KEY = ''; // never a real LLM call from tests
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';

fs.copyFileSync(path.join(REPO_CONFIG, 'profile.example.json'), path.join(CONFIG_DIR, 'profile.json'));
const BANK: import('../src/lib/types').AnswerBank = {
  entries: [
    { id: 'heard-about', patterns: ['how did you hear', 'where did you hear'], answer: 'Company website', type: 'select' },
    { id: 'right-to-work-ireland', patterns: ['right to work in ireland', 'authorised to work in ireland', 'eligible to work'], answer: 'Yes', type: 'yesno' },
    { id: 'highest-education', patterns: ['highest level of education'], answer: "Bachelor's Degree", type: 'select' },
    { id: 'salary-expectation', patterns: ['salary expectation', 'expected salary', 'expected annual salary'], answer: '40000', type: 'number', confirm: true },
    { id: 'data-processing-consent', patterns: ['processing of my personal data'], answer: 'Yes', type: 'yesno' },
  ],
};
fs.writeFileSync(path.join(CONFIG_DIR, 'answers.json'), JSON.stringify(BANK));

const CV_PATH = path.join(TMP, 'Jane_Doe_CV.pdf');
fs.writeFileSync(CV_PATH, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const COVER_TEXT = 'Hi,\n\nI would like to apply for this role.\n\nKind Regards,\nJane';

const dbm = await import('../src/lib/db');
const runner = await import('../src/engine/apply/runner');
const detect = await import('../src/engine/apply/detect');
const fields = await import('../src/engine/apply/fields');
const llmfill = await import('../src/engine/apply/llmfill');
const browser = await import('../src/engine/apply/browser');
type NewJob = import('../src/lib/types').NewJob;
type AnsweredQuestion = import('../src/lib/types').AnsweredQuestion;

// ───────────────────────────── Fixture server ─────────────────────────────

const ROUTES: Record<string, string> = {
  '/_harness.js': '_harness.js',
  '/smartrecruiters/AcmeComms/744000000000001-pr-executive': 'sr_job.html',
  '/smartrecruiters/oneclick-ui/company/AcmeComms/publication/3f2c9a7e-1b2d-4c5e-8f90-0a1b2c3d4e5f': 'sr_oneclick.html',
  '/workable/acme-comms/j/A1B2C3D4E5/apply/': 'workable_form.html',
  '/careers/acme-comms/pr-executive': 'company_job.html',
  '/careers/acme-comms/pr-executive/apply': 'company_apply.html',
  '/careers/acme-comms/pr-executive/apply/thank-you': 'company_thanks.html',
  '/jobs/acme-retail/123/apply': 'account_wall.html',
  '/careers/acme-gh': 'greenhouse_embed_company.html',
  '/greenhouse/embed/job_app': 'greenhouse_form.html',
  '/greenhouse/embed/job_app/confirmation': 'greenhouse_confirmation.html',
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

const RUN = { profileDir: PROFILE_DIR, allowHosts: ['127.0.0.1'], deadlineMs: 90_000 };

let dbCounter = 0;
function freshDb(): void {
  dbm.closeDb();
  process.env.PURSUIT_DB_PATH = path.join(TMP, `t${++dbCounter}.db`);
  for (const k of Object.keys(submissions)) delete submissions[k];
}

let jobCounter = 0;
function seedJob(over: Partial<NewJob>, opts: { answers?: AnsweredQuestion[] } = {}): string {
  const id = `atstest${String(++jobCounter).padStart(8, '0')}`;
  const url = over.url ?? `${BASE}/careers/acme-comms/pr-executive`;
  const job: NewJob = {
    id, source: 'manual', sourceId: id, company: `Acme Comms ${jobCounter}`, title: `PR Executive ${jobCounter}`,
    location: 'Dublin, Ireland', country: 'IE', remote: false, url, applyUrl: url, ats: 'unknown', atsMeta: {}, description: 'Fixture job.',
    ...over,
  };
  dbm.upsertJob(job);
  dbm.setStatus(id, 'approved');
  dbm.addArtifact({ jobId: id, kind: 'cv_pdf', path: CV_PATH, meta: { summaryVariant: 'pr' } });
  dbm.addArtifact({ jobId: id, kind: 'cover_letter', content: COVER_TEXT });
  dbm.addArtifact({ jobId: id, kind: 'answers', content: JSON.stringify(opts.answers ?? []) });
  return id;
}

function aq(id: string, label: string, answer: string | null, type: AnsweredQuestion['type'] = 'text'): AnsweredQuestion {
  return { id, label, type, required: true, answer, source: answer === null ? 'none' : 'bank', needsHuman: answer === null };
}

function last(name: string): Record<string, unknown> {
  const list = submissions[name] ?? [];
  assert.ok(list.length > 0, `expected a recorded ${name} submission`);
  return list[list.length - 1];
}

const CV_FILE = [{ name: path.basename(CV_PATH), size: fs.statSync(CV_PATH).size }];

before(startServer);
beforeEach(freshDb);
after(async () => {
  await browser.closeAllBrowsers();
  await new Promise<void>((r) => server.close(() => r()));
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── Pure helpers ─────────────────────────────

describe('browser launch config (Docker / Linux servers)', () => {
  test('default is installed Chrome, headed allowed', () => {
    assert.deepEqual(browser.resolveBrowserLaunch({}), { channel: 'chrome', forceHeadless: false });
    assert.deepEqual(browser.launchOptions({ headless: false }, {}), { headless: false, channel: 'chrome' });
  });
  test("'' or 'chromium' → bundled Chromium (no channel)", () => {
    assert.deepEqual(browser.resolveBrowserLaunch({ PURSUIT_BROWSER_CHANNEL: '' }), { forceHeadless: false });
    assert.deepEqual(browser.resolveBrowserLaunch({ PURSUIT_BROWSER_CHANNEL: 'chromium' }), { forceHeadless: false });
    assert.equal(browser.launchOptions({ headless: true }, { PURSUIT_BROWSER_CHANNEL: 'chromium' }).channel, undefined);
    assert.equal(browser.resolveBrowserLaunch({ PURSUIT_BROWSER_CHANNEL: 'msedge' }).channel, 'msedge');
  });
  test('PURSUIT_CHROMIUM_PATH wins over the channel; PURSUIT_FORCE_HEADLESS=1 forces headless', () => {
    const env = { PURSUIT_CHROMIUM_PATH: '/usr/bin/chromium', PURSUIT_BROWSER_CHANNEL: 'chrome', PURSUIT_FORCE_HEADLESS: '1' };
    assert.deepEqual(browser.resolveBrowserLaunch(env), { executablePath: '/usr/bin/chromium', forceHeadless: true });
    const opts = browser.launchOptions({ headless: false }, env);
    assert.equal(opts.headless, true, 'a headed request degrades to headless');
    assert.equal(opts.executablePath, '/usr/bin/chromium');
    assert.equal(opts.channel, undefined);
    assert.equal(browser.effectiveHeadless(false, { PURSUIT_FORCE_HEADLESS: '1' }), true);
    assert.equal(browser.effectiveHeadless(false, {}), false);
  });
});

describe('detectSite', () => {
  test('knows the new ATSs and the account-wall ATSs; detectAts keeps the shared contract', () => {
    assert.equal(detect.detectSite('https://acme.teamtailor.com/jobs/123-pr-executive'), 'teamtailor');
    assert.equal(detect.detectSite('https://acme.jobs.personio.de/job/2888695'), 'personio');
    assert.equal(detect.detectSite('https://acme.recruitee.com/o/pr-executive'), 'recruitee');
    assert.equal(detect.detectSite('https://acme.bamboohr.com/careers/179'), 'bamboohr');
    assert.equal(detect.detectSite('https://careers-acme.icims.com/jobs/1234/pr-executive/job'), 'icims');
    assert.equal(detect.detectSite('https://acme.taleo.net/careersection/2/jobdetail.ftl?job=123'), 'taleo');
    assert.equal(detect.detectSite('https://career5.successfactors.eu/career?company=acme'), 'successfactors');
    assert.equal(detect.detectSite('https://jobs.smartrecruiters.com/Ryanair/744000000000001-cabin-crew'), 'smartrecruiters');
    assert.equal(detect.detectAts('https://acme.teamtailor.com/jobs/1'), 'unknown');
    assert.ok(detect.ACCOUNT_WALL_SITES.includes('workday'));
  });
});

describe('consent classification', () => {
  test('data processing vs marketing vs attestation', () => {
    assert.equal(fields.classifyConsent('I have read, understand and accept the content of the Privacy Notice and consent to the processing of my data as part of this application.'), 'processing');
    assert.equal(fields.classifyConsent('I consent to Acme Comms processing my personal data for this application, as described in the privacy notice'), 'processing');
    assert.equal(fields.classifyConsent('Yes, I would like to join the Acme Comms talent community and hear about future opportunities'), 'marketing');
    assert.equal(fields.classifyConsent('I consent to the hiring team of this job contacting me via text message.'), 'marketing');
    assert.equal(fields.classifyConsent('Email me job alerts and news about future opportunities'), 'marketing');
    assert.equal(fields.classifyConsent('Please keep my CV on file and contact me about other vacancies, in line with the privacy policy'), 'marketing');
    assert.equal(fields.classifyConsent('I certify that the information provided is true and complete'), 'attestation');
    assert.equal(fields.classifyConsent('I accept the Terms and Conditions and the Privacy Policy'), 'attestation');
    assert.equal(fields.classifyConsent('Are you willing to relocate?'), null);
  });
  test('the bank consent entry only applies to data-processing boxes', () => {
    assert.equal(fields.bankConsents('I agree to the privacy policy', BANK), true);
    assert.equal(fields.bankConsents('I agree to the privacy policy', { entries: [] }), false);
  });
});

describe('LLM mapping guard (never invents)', () => {
  const pkg = {
    job: { id: 'x', source: 'manual', title: 'PR Executive', company: 'Acme', description: '' },
    profile: JSON.parse(fs.readFileSync(path.join(REPO_CONFIG, 'profile.example.json'), 'utf8')),
    cvPdfPath: CV_PATH, coverLetterText: '', answers: [],
  } as unknown as import('../src/lib/types').ApplyPackage;
  const raw = (idx: number, label: string, options: string[] = []) => ({
    field: { idx, kind: options.length ? 'select' : 'text', label, rawLabel: label, required: true, options, optionDomIndex: options.map((_, i) => i + 1), name: `f${idx}`, id: `f${idx}`, type: 'text', autocomplete: '', placeholder: '', hasValue: false, eeoSection: false, hasManualToggle: false } as import('../src/engine/apply/inpage').RawField,
    question: { id: `f${idx}`, label, type: (options.length ? 'select' : 'text') as 'select' | 'text', required: true, ...(options.length ? { options } : {}) },
  });

  test('values come from our data; wrong-topic and unknown keys are rejected', () => {
    const sources = llmfill.knownSources(pkg, BANK);
    const inputs = [
      raw(0, 'Which county do you live in?', ['Dublin', 'Cork', 'Example', 'Outside Ireland']),
      raw(1, 'What are your salary expectations?'),
      raw(2, 'Earliest start date'),
      raw(3, 'Your city'),
    ];
    const out = llmfill.applyMappings(inputs, [
      { field: 'f0', key: 'profile.location', option: 0 },          // model says Dublin; our data says Example
      { field: 'f1', key: 'bank.heard-about' },                     // wrong topic
      { field: 'f2', key: 'bank.made-up-key' },                     // unknown key
      { field: 'f3', key: 'profile.city' },
    ], sources);
    assert.equal(out.get(0)?.value, 'Example', 'deterministic option from the profile, not the model\'s pick');
    assert.equal(out.has(1), false);
    assert.equal(out.has(2), false);
    assert.equal(out.get(3)?.value, 'Exampletown');
    assert.equal(out.get(3)?.source, 'llm-map');
  });

  test('sensitive values are never shown to the model; unconfirmed entries are not offered', () => {
    const known = llmfill.knownAnswers(pkg, BANK);
    assert.ok(!known.some((k) => k.key === 'bank.salary-expectation'), 'unconfirmed salary entry not offered');
    assert.ok(!known.some((k) => k.key === 'bank.data-processing-consent'), 'consent is never mapped by the model');
    assert.equal(known.find((k) => k.key === 'bank.right-to-work-ireland')?.value, undefined, 'right-to-work value hidden');
    assert.equal(known.find((k) => k.key === 'profile.email')?.value, undefined, 'contact details hidden');
    assert.equal(llmfill.topicOf('Do you now or in the future require visa sponsorship?'), 'sponsorship');
  });
});

// ───────────────────────────── Guards (no browser) ─────────────────────────────

describe('routing guards', () => {
  test('LinkedIn / Indeed apply URLs are skipped, never loaded, whatever job.ats says', async () => {
    for (const [ats, url] of [
      ['smartrecruiters', 'https://www.linkedin.com/jobs/view/4012345'],
      ['workable', 'https://www.linkedin.com/jobs/view/4012346'],
      ['unknown', 'https://ie.indeed.com/viewjob?jk=abc'],
      ['linkedin', 'https://www.linkedin.com/jobs/view/4012347'],
    ] as const) {
      const id = seedJob({ url, applyUrl: url, ats, source: 'linkedin_guest' });
      const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
      assert.equal(out.status, 'skipped', `${ats} ${url}`);
      assert.deepEqual(out.needs, [runner.NEED_NOT_RESOLVED]);
      assert.equal(dbm.listApplications({ jobId: id }).length, 0);
      assert.equal(dbm.getJob(id)?.status, 'approved');
      assert.equal(runner.isResolvedForApply(dbm.getJob(id)!), false);
    }
  });

  test('a LinkedIn-sourced job resolved to an employer URL is routed to that site', () => {
    const r = runner.siteForJob({ ats: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1', applyUrl: 'https://jobs.smartrecruiters.com/Ryanair/744000000000001-cabin-crew' });
    assert.equal(r.site, 'smartrecruiters');
  });

  test('Workday / iCIMS / Taleo / SuccessFactors → needs_you account_required without opening a browser', async () => {
    for (const url of [
      'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dublin/PR-Executive_R123',
      'https://careers-acme.icims.com/jobs/1234/pr-executive/job',
      'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=123',
      'https://career5.successfactors.eu/career?company=acme&career_job_req_id=1',
    ]) {
      const id = seedJob({ url, applyUrl: url });
      const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
      assert.equal(out.status, 'needs_you', url);
      assert.deepEqual(out.blockedBy, ['account_required'], url);
      assert.match(out.needs?.[0] ?? '', /sign in or create an account/);
      assert.equal(dbm.getJob(id)?.status, 'needs_you');
    }
  });

  test('Greenhouse jobs with board ids always use the embed form URL', () => {
    const r = runner.siteForJob({ ats: 'greenhouse', url: 'https://stripe.com/jobs/search?gh_jid=8357049', applyUrl: 'https://stripe.com/jobs/search?gh_jid=8357049', atsMeta: { boardToken: 'stripe', jobId: 8357049 } });
    assert.deepEqual(r, { site: 'greenhouse', applyUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8357049' });
    assert.equal(runner.siteForJob({ ats: 'greenhouse', url: 'https://x.test/?gh_jid=1', applyUrl: 'https://x.test/?gh_jid=1', atsMeta: {} }).applyUrl, 'https://x.test/?gh_jid=1');
  });
});

// ───────────────────────────── Browser runs ─────────────────────────────

const SR_JOB = () => `${BASE}/smartrecruiters/AcmeComms/744000000000001-pr-executive`;
const WK_FORM = () => `${BASE}/workable/acme-comms/j/A1B2C3D4E5/apply/`;
const CO_JOB = () => `${BASE}/careers/acme-comms/pr-executive`;
const WHY = aq('why', 'Why do you want to work at Acme Comms?', 'I like the mix of media relations and community work at Acme.', 'textarea');

describe('SmartRecruiters', { timeout: 300_000 }, () => {
  test('job page → OneTrust rejected → I\'m interested → 2-step shadow-DOM form → submit → confirmed', async () => {
    const id = seedJob({ url: SR_JOB(), applyUrl: SR_JOB(), ats: 'smartrecruiters', source: 'smartrecruiters' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /application-success|thank you for applying/i);
    assert.ok(out.screenshotPath && fs.existsSync(out.screenshotPath));
    assert.deepEqual(last('sr-cookies'), { choice: 'reject' });
    const sent = last('smartrecruiters');
    assert.equal(sent.firstName, 'Jane', 'profile name replaces the resume-parser pre-fill');
    assert.equal(sent.lastName, 'Doe');
    assert.equal(sent.email, 'jane.doe@example.com');
    assert.equal(sent.confirmEmail, 'jane.doe@example.com');
    assert.equal(sent.city, 'Exampletown, Co. Example, Ireland', 'autocomplete suggestion picked');
    assert.equal(sent.phoneCountryCode, '+353');
    assert.equal(sent.phoneNumber, '1 555 0100', 'national number next to the +353 picker');
    assert.deepEqual(sent.resume, CV_FILE, 'absolute CV path uploaded');
    assert.equal(sent.hiringTeamMessage, COVER_TEXT, 'cover letter in "Message to the Hiring Team"');
    assert.equal(sent.linkedin, 'https://www.linkedin.com/in/jane-doe-example');
    assert.equal(sent.q_rtw, 'Yes');
    assert.equal(sent.q_source, 'Company website');
    assert.deepEqual(sent.privacyConsent, ['accepted'], 'data-processing consent ticked (bank OK on file)');
    assert.equal(sent.talentCommunity, undefined, 'talent-community opt-in never ticked');
    assert.equal(dbm.getJob(id)?.status, 'applied');
  });

  test('unknown required question → needs_you listing exactly that question, nothing submitted', async () => {
    const url = `${SR_JOB()}?variant=extra`;
    const id = seedJob({ url, applyUrl: url, ats: 'smartrecruiters' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.questions?.map((q) => q.label), ['What is your expected annual salary (EUR)?']);
    assert.equal(out.questions?.[0].type, 'number');
    assert.ok(out.blockedBy?.includes('unknown_required_field'));
    assert.equal(submissions.smartrecruiters, undefined);
    assert.deepEqual((dbm.getJob(id)?.atsMeta.pendingQuestions as { label: string }[]).map((q) => q.label), ['What is your expected annual salary (EUR)?']);
  });

  test('DataDome bot wall → needs_you captcha, no form touched', async () => {
    const url = `${SR_JOB()}?variant=datadome`;
    const id = seedJob({ url, applyUrl: url, ats: 'smartrecruiters' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.blockedBy, ['captcha']);
    assert.ok(out.needs?.some((n) => /captcha|bot check/i.test(n)));
    assert.equal(submissions.smartrecruiters, undefined);
  });

  test('sign-in wall → needs_you account_required, nothing typed', async () => {
    const url = `${SR_JOB()}?variant=account`;
    const id = seedJob({ url, applyUrl: url, ats: 'smartrecruiters' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('account_required'), JSON.stringify(out));
    assert.equal(submissions['sr-login'], undefined);
  });
});

describe('Workable', { timeout: 300_000 }, () => {
  test('cookie banner declined, form filled, GDPR ticked, SMS opt-in not, submitted and confirmed', async () => {
    const id = seedJob({ url: WK_FORM(), applyUrl: WK_FORM(), ats: 'workable', source: 'workable' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /submitted successfully/i);
    assert.deepEqual(last('workable-cookies'), { choice: 'decline' });
    const sent = last('workable');
    assert.equal(sent.firstname, 'Jane');
    assert.equal(sent.lastname, 'Doe');
    assert.equal(sent.email, 'jane.doe@example.com');
    assert.equal(sent.phone, '+353 1 555 0100');
    assert.deepEqual(sent.resume, CV_FILE);
    assert.equal(sent.cover_letter, COVER_TEXT);
    assert.equal(sent.CA_10628, 'true');
    assert.equal(sent.CA_10629, 'Company website');
    assert.deepEqual(sent.gdpr, ['on']);
    assert.equal(sent.sms, undefined, 'SMS / marketing opt-in never ticked');
  });

  test('unknown required question → needs_you with the question listed', async () => {
    const url = `${WK_FORM()}?variant=extra`;
    const id = seedJob({ url, applyUrl: url, ats: 'workable' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.questions?.map((q) => q.label), ['Can you confirm that everything in this application is true and your own, including your experience and identity?']);
    assert.deepEqual(out.questions?.[0].options, ['Yes', 'No']);
    assert.equal(submissions.workable, undefined);
  });

  test('visible reCAPTCHA → needs_you captcha, submit never clicked', async () => {
    const url = `${WK_FORM()}?variant=captcha`;
    const id = seedJob({ url, applyUrl: url, ats: 'workable' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('captcha'));
    assert.equal(submissions.workable, undefined);
  });

  test('account wall → needs_you account_required', async () => {
    const url = `${WK_FORM()}?variant=account`;
    const id = seedJob({ url, applyUrl: url, ats: 'workable' });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('account_required'));
    assert.equal(submissions.workable, undefined);
  });
});

describe('Universal filler (company forms, multi-step)', { timeout: 300_000 }, () => {
  test('Apply now → 3 steps → consent ticked, job alerts not → submitted → thank-you page', async () => {
    const calls: { fields: { label: string }[]; known: { key: string; value?: string }[] }[] = [];
    const llm: import('../src/engine/apply/llmfill').LlmMapper = async (input) => {
      calls.push(input);
      return input.fields.map((f) => ({ field: f.ref, key: /county/i.test(f.label) ? 'profile.location' : null, option: null }));
    };
    const id = seedJob({}, { answers: [WHY] });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN, allowLLM: true, llm });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.match(out.confirmation ?? '', /thank you for your application|thank-you/i);
    assert.deepEqual(last('company-cookies'), { choice: 'reject' });
    assert.equal(submissions.newsletter, undefined, 'footer newsletter box untouched');
    const sent = last('company');
    assert.equal(sent.first_name, 'Jane');
    assert.equal(sent.surname, 'Doe');
    assert.equal(sent.email_address, 'jane.doe@example.com');
    assert.equal(sent.dial_code, '+353');
    assert.equal(sent.mobile, '1 555 0100');
    assert.equal(sent.city, 'Exampletown, Co. Example, Ireland');
    assert.deepEqual(sent.cv, CV_FILE);
    assert.equal(sent.rtw, 'yes');
    assert.equal(sent.source, 'Company website');
    assert.equal(sent.education, "Level 8 Honours Bachelor's Degree");
    assert.equal(sent.county, 'Example', 'mapped to the profile location, option chosen from our data');
    assert.equal(sent.why, WHY.answer);
    assert.equal(sent.start_date, '', 'optional date left empty (no invented date)');
    assert.deepEqual(sent.privacy, ['yes']);
    assert.equal(sent.job_alerts, undefined, 'marketing opt-in never ticked');
    assert.equal(calls.length, 1, 'one mapping call, for the county question only');
    assert.deepEqual(calls[0].fields.map((f) => f.label), ['Which county do you live in?']);
    const events = dbm.listEvents({ jobId: id, limit: 100 }).filter((e) => e.type === 'apply.filled');
    assert.ok(JSON.stringify(events).includes('llm-map'));
  });

  test('without the LLM the county and why questions come back as questions; nothing submitted', async () => {
    const id = seedJob({});
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.questions?.map((q) => q.label).sort(), ['Which county do you live in?', 'Why do you want to work at Acme Comms?']);
    assert.ok(out.questions?.find((q) => /county/.test(q.label))?.options?.includes('Example'));
    assert.equal(submissions.company, undefined);
  });

  test('the LLM can\'t answer salary by pointing at another answer: needs_you with that question', async () => {
    const llm: import('../src/engine/apply/llmfill').LlmMapper = async (input) =>
      input.fields.map((f) => ({ field: f.ref, key: /county/i.test(f.label) ? 'profile.location' : 'bank.heard-about', option: 0 }));
    const url = `${CO_JOB()}?variant=extra`;
    const id = seedJob({ url, applyUrl: url }, { answers: [WHY] });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN, allowLLM: true, llm });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.deepEqual(out.questions?.map((q) => q.label), ['What are your salary expectations?']);
    assert.equal(submissions.company, undefined);
  });

  test('Arkose challenge on the last step → needs_you captcha, submit never clicked', async () => {
    const url = `${CO_JOB()}?variant=arkose`;
    const id = seedJob({ url, applyUrl: url }, { answers: [WHY] });
    const llm: import('../src/engine/apply/llmfill').LlmMapper = async (input) => input.fields.map((f) => ({ field: f.ref, key: 'profile.location', option: null }));
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN, allowLLM: true, llm });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('captcha'), JSON.stringify(out));
    assert.equal(submissions.company, undefined);
  });

  test('"create an account to apply" → needs_you account_required, no account created', async () => {
    const url = `${CO_JOB()}?variant=account`;
    const id = seedJob({ url, applyUrl: url });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('account_required'), JSON.stringify(out));
    assert.equal(submissions['company-account'], undefined);
  });

  test('candidate-portal sign-in wall on a company domain → account_required, password never typed', async () => {
    const url = `${BASE}/jobs/acme-retail/123/apply`;
    const id = seedJob({ url, applyUrl: url });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'needs_you', JSON.stringify(out));
    assert.ok(out.blockedBy?.includes('account_required'), JSON.stringify(out));
    assert.equal(submissions.wall, undefined);
  });
});

describe('Greenhouse embeds (employer career sites)', { timeout: 300_000 }, () => {
  const GH_ANSWERS: AnsweredQuestion[] = [
    aq('question_1001', 'Are you authorised to work in the country in which this role is located?', 'Yes', 'select'),
    aq('question_1002', 'Current or most recent company?', 'Example Students Union'),
    aq('question_1007', 'Please email me about future job openings', 'No', 'select'),
    aq('question_1008', 'I consent to Acme Comms processing my personal data for this application, as described in the privacy notice', 'Yes', 'checkbox'),
  ];

  test('company page embedding #grnhse_iframe → the iframe form is filled and submitted', async () => {
    const url = `${BASE}/careers/acme-gh?gh_jid=4012345`;
    const id = seedJob({ url, applyUrl: url, ats: 'greenhouse', source: 'greenhouse' }, { answers: GH_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    const sent = last('greenhouse');
    assert.equal(sent.first_name, 'Jane');
    assert.deepEqual(sent.resume, CV_FILE);
  });

  test('board token + job id → straight to the embed form even when the apply URL has no form', async () => {
    const url = `${BASE}/careers/acme-gh?noembed=1&gh_jid=4012345`;
    const id = seedJob({ url, applyUrl: url, ats: 'greenhouse', source: 'greenhouse', atsMeta: { boardToken: 'acme', jobId: 4012345 } }, { answers: GH_ANSWERS });
    const out = await runner.applyToJob(id, { mode: 'submit', headless: true, ...RUN, greenhouseEmbedBase: `${BASE}/greenhouse/embed/job_app` });
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.equal(last('greenhouse').email, 'jane.doe@example.com');
  });
});
