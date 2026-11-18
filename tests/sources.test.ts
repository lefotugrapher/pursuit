// Discovery tests: polite Http, normalisation, every adapter against saved fixtures, alert-email parsing,
// and runDiscovery against a temp DB. No network: adapters get a stub Http that serves fixture files.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-sources-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'sources.db');

const { createHttp, parseRetryAfter, redactUrl, USER_AGENT } = await import('../src/engine/sources/http');
const norm = await import('../src/engine/sources/normalize');
const { greenhouse } = await import('../src/engine/sources/greenhouse');
const { lever } = await import('../src/engine/sources/lever');
const { ashby } = await import('../src/engine/sources/ashby');
const { smartrecruiters } = await import('../src/engine/sources/smartrecruiters');
const { workable } = await import('../src/engine/sources/workable');
const li = await import('../src/engine/sources/linkedinGuest');
const { adzuna } = await import('../src/engine/sources/adzuna');
const { parseAlertEmail, parseJobLink } = await import('../src/engine/sources/gmailAlerts');
const { runDiscovery, ADAPTERS } = await import('../src/engine/sources/index');
const dbm = await import('../src/lib/db');

type Http = import('../src/lib/types').Http;
type SourcesConfig = import('../src/lib/types').SourcesConfig;
type SourceContext = import('../src/lib/types').SourceContext;
type Profile = import('../src/lib/types').Profile;
type RawJob = import('../src/lib/types').RawJob;
type WatchCompany = import('../src/lib/types').WatchCompany;
type InboundEmail = import('../src/lib/types').InboundEmail;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'sources');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'profile.example.json'), 'utf8')) as Profile;
const REAL_SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sources.json'), 'utf8')) as SourcesConfig;

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── helpers ─────────────────────────────

type Route = { match: (url: string) => boolean; status?: number; body: string | (() => string); finalUrl?: string };

class StubHttp implements Http {
  readonly calls: { url: string; minIntervalMs?: number }[] = [];
  constructor(private readonly routes: Route[]) {}
  async get(url: string, opts?: { minIntervalMs?: number }) {
    this.calls.push({ url, minIntervalMs: opts?.minIntervalMs });
    const route = this.routes.find((r) => r.match(url));
    if (!route) return { status: 404, text: 'not found', url };
    return { status: route.status ?? 200, text: typeof route.body === 'function' ? route.body() : route.body, url: route.finalUrl ?? url };
  }
  async json<T>(url: string, opts?: { minIntervalMs?: number }): Promise<T> {
    const res = await this.get(url, opts);
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return JSON.parse(res.text) as T;
  }
}

const silentLog = { info() {}, warn() {}, error() {} };

function sources(over: Partial<SourcesConfig> = {}): SourcesConfig {
  return {
    companies: [],
    linkedinGuest: { enabled: false, queries: [], maxPerQuery: 25, minIntervalMs: 3000 },
    adzuna: { enabled: false, queries: [] },
    gmailAlerts: { enabled: true },
    boardSearch: { enabled: false, queries: [] },
    titleMustMatch: REAL_SOURCES.titleMustMatch,
    ...over,
  };
}

function ctxFor(http: Http, over: Partial<SourcesConfig> = {}): SourceContext {
  return { sources: sources(over), profile: PROFILE, http, log: silentLog };
}

const company = (name: string, ats: WatchCompany['ats'], token: string): WatchCompany => ({ name, ats, token, enabled: true });

function email(file: string, fromAddress: string): InboundEmail {
  const body = fixture(path.join('emails', file));
  const html = file.endsWith('.html');
  return {
    messageId: `<${file}@test>`, from: `Alerts <${fromAddress}>`, fromAddress, subject: 'Job alert',
    date: '2026-11-14T08:00:00.000Z', text: html ? '' : body, html: html ? body : undefined,
  };
}

// ───────────────────────────── http ─────────────────────────────

describe('http', () => {
  function fakeClock() {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
  }

  test('sends the Pursuit UA, no cookies, and spaces requests to one host', async () => {
    const clock = fakeClock();
    const seen: { url: string; init?: RequestInit }[] = [];
    const http = createHttp({
      now: clock.now, sleep: clock.sleep,
      fetchImpl: (async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch,
    });
    await http.json('https://a.example/1');
    await http.json('https://a.example/2', { minIntervalMs: 3000 });
    await http.json('https://b.example/1');
    assert.equal(seen.length, 3);
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers['User-Agent'], USER_AGENT);
    assert.equal(seen[0].init?.credentials, 'omit');
    assert.deepEqual(clock.sleeps, [3000]); // second a.example call waited; b.example did not
  });

  test('retries 5xx with backoff, then succeeds', async () => {
    const clock = fakeClock();
    let n = 0;
    const http = createHttp({
      now: clock.now, sleep: clock.sleep,
      fetchImpl: (async () => (++n < 3 ? new Response('down', { status: 503 }) : new Response('[1]', { status: 200 }))) as unknown as typeof fetch,
    });
    assert.deepEqual(await http.json('https://c.example/x'), [1]);
    assert.equal(n, 3);
  });

  test('a long Retry-After on 429 parks the host for the run', async () => {
    const clock = fakeClock();
    let n = 0;
    const http = createHttp({
      now: clock.now, sleep: clock.sleep,
      fetchImpl: (async () => { n++; return new Response('slow down', { status: 429, headers: { 'retry-after': '86400' } }); }) as unknown as typeof fetch,
    });
    const res = await http.get('https://d.example/1');
    assert.equal(res.status, 429);
    await assert.rejects(http.get('https://d.example/2'), /rate-limiting/);
    assert.equal(n, 1);
    assert.equal(http.blockedHosts()[0].host, 'd.example');
  });

  test('non-2xx JSON throws an error with status; secrets in URLs are redacted', async () => {
    const http = createHttp({ fetchImpl: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch, sleep: async () => {} });
    await assert.rejects(http.json('https://e.example/x?app_key=supersecret123'), (err: Error & { status?: number }) => {
      assert.equal(err.status, 404);
      assert.doesNotMatch(err.message, /supersecret123/);
      return true;
    });
    assert.match(redactUrl('https://api.adzuna.com/x?app_id=abc&app_key=def'), /app_key=REDACTED/);
    assert.equal(parseRetryAfter('5'), 5000);
  });
});

// ───────────────────────────── normalize ─────────────────────────────

describe('normalize', () => {
  test('htmlToText keeps paragraphs and lists, decodes entities, handles escaped HTML', () => {
    const text = norm.htmlToText('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two&nbsp;items</li></ul><script>x()</script><p>Bye&#33;</p>');
    assert.equal(text, 'Hello & welcome\n\n- One\n- Two items\n\nBye!');
    assert.equal(norm.htmlToText('<ul><li><p>First</p></li><li><div><div><p>Second</p></div></div></li></ul>'), '- First\n- Second');
    assert.equal(norm.htmlToText('&lt;p&gt;Escaped &amp;amp; fine&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;'), 'Escaped & fine\n\nTwo');
    assert.equal(norm.htmlToText('Line one<br/>Line two'), 'Line one\nLine two');
  });

  test('parseSalary: ranges, k suffix, currencies, hourly and daily rates', () => {
    assert.deepEqual(norm.parseSalary('€35,000 - €40,000'), { min: 35000, max: 40000, currency: 'EUR', period: 'year', raw: '€35,000 - €40,000' });
    assert.equal(norm.parseSalary('£25k-£30k')?.max, 30000);
    assert.equal(norm.parseSalary('£25k-£30k')?.currency, 'GBP');
    assert.deepEqual([norm.parseSalary('€30-35k')?.min, norm.parseSalary('€30-35k')?.max], [30000, 35000]);
    assert.equal(norm.parseSalary('€15 per hour')?.min, 15 * 1950);
    assert.equal(norm.parseSalary('£200 per day')?.min, 200 * 230);
    assert.equal(norm.parseSalary('€3,000 per month')?.min, 36000);
    assert.equal(norm.parseSalary('EUR 36700 per year')?.currency, 'EUR');
    assert.equal(norm.parseSalary('35.000 EUR p.a.')?.min, 35000);
    assert.equal(norm.parseSalary('Competitive'), undefined);
    assert.equal(norm.parseSalary('We serve 50,000 customers', { requireCurrency: true }), undefined);
    assert.equal(norm.findSalaryInText('About us\nWe have 2,000 staff.\nSalary: €38,000 – €42,000 DOE')?.max, 42000);
  });

  test('detectCountry: Ireland, Northern Ireland towns, GB, remote, US lookalikes', () => {
    const cases: [string, string | undefined][] = [
      ['Dublin, County Dublin, Ireland', 'IE'], ['Ireland - Dublin Hub (Hybrid)', 'IE'], ['Dundalk, Co. Louth', 'IE'],
      ['Newry', 'GB-NIR'], ['Belfast, United Kingdom', 'GB-NIR'], ['Lisburn, Co. Antrim', 'GB-NIR'], ['Armagh', 'GB-NIR'],
      ['London, UK', 'GB'], ['Manchester, England', 'GB'],
      ['Remote', 'REMOTE'], ['Remote - EMEA', 'REMOTE'], ['Europe', 'REMOTE'],
      ['Dublin, OH', 'OTHER'], ['Dublin, California, United States', 'OTHER'], ['Berlin, Germany', 'OTHER'], ['Remote - US', 'OTHER'],
      ['', undefined],
    ];
    for (const [loc, want] of cases) assert.equal(norm.detectCountry(loc), want, loc);
    assert.equal(norm.detectCountry('Sweden', true), 'OTHER');
    assert.equal(norm.locationAllowed('Karachi, Pakistan'), false);
    assert.equal(norm.locationAllowed('London / Dublin'), true);
    assert.equal(norm.locationAllowed(undefined), true);
  });

  test('titleExcluded drops accidental matches but keeps target roles', () => {
    for (const t of ['iOS Engineer - Creative App', 'Your next opportunity at Flipdish – Ireland Talent Community', 'Commercial Counsel - US', 'Senior Software Developer, Content Platform'])
      assert.equal(norm.titleExcluded(t), true, t);
    for (const t of ['Marketing Executive', 'PR & Communications Officer', 'Content Creator', 'Partnerships Executive', 'Brand Engagement Coordinator'])
      assert.equal(norm.titleExcluded(t), false, t);
  });

  test('detectRemote: remote yes, hybrid no', () => {
    assert.equal(norm.detectRemote('Remote - Ireland'), true);
    assert.equal(norm.detectRemote('Dublin (Hybrid)'), false);
    assert.equal(norm.detectRemote('Dublin', 'PR Executive', 'This role is remote within Ireland.'), true);
  });

  test('detectAts recognises every ATS and board', () => {
    const cases: [string, string][] = [
      ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'], ['https://boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse'],
      ['https://acme.com/careers?gh_jid=123', 'greenhouse'], ['https://jobs.lever.co/acme/uuid/apply', 'lever'],
      ['https://jobs.ashbyhq.com/acme/uuid', 'ashby'], ['https://jobs.smartrecruiters.com/Acme/123', 'smartrecruiters'],
      ['https://apply.workable.com/acme/j/ABC/', 'workable'], ['https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x', 'workday'],
      ['https://www.linkedin.com/jobs/view/1', 'linkedin'], ['https://ie.indeed.com/viewjob?jk=abc', 'indeed'],
      ['mailto:jobs@acme.ie', 'email'], ['https://acme.ie/careers', 'unknown'], ['not a url', 'unknown'],
    ];
    for (const [url, want] of cases) assert.equal(norm.detectAts(url), want, url);
  });

  test('canonicalUrl strips tracking and keeps job ids', () => {
    assert.equal(norm.canonicalUrl('https://www.linkedin.com/jobs/view/123/?trk=abc&refId=x&trackingId=y#frag'), 'https://www.linkedin.com/jobs/view/123/');
    assert.equal(norm.canonicalUrl('https://acme.com/careers?gh_jid=55&utm_source=li'), 'https://acme.com/careers?gh_jid=55');
    assert.equal(norm.canonicalUrl('https://ie.indeed.com/viewjob?jk=abc&from=ja&tk=1'), 'https://ie.indeed.com/viewjob?jk=abc');
  });

  test('jobId is stable 16-hex and collapses equivalent company/location spellings', () => {
    const a = norm.jobId('Acme Ltd', 'Marketing Executive', 'Dublin, County Dublin, Ireland');
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, norm.jobId('ACME', 'Marketing  Executive', 'Ireland - Dublin Hub (Hybrid)'));
    assert.notEqual(a, norm.jobId('Acme', 'Marketing Executive', 'Belfast'));
  });

  test('normalizeJob builds a complete NewJob', () => {
    const job = norm.normalizeJob({
      source: 'greenhouse', sourceId: '1', company: ' Acme ', title: 'PR&nbsp;Executive', location: 'Dublin, Ireland',
      url: 'https://job-boards.greenhouse.io/acme/jobs/1?utm_source=x',
      descriptionHtml: '<p>Join us.</p><p>Salary €36,000 - €40,000 per annum</p>', employmentType: 'FullTime', postedAt: '2026-11-10',
    });
    assert.equal(job.title, 'PR Executive');
    assert.equal(job.company, 'Acme');
    assert.equal(job.country, 'IE');
    assert.equal(job.remote, false);
    assert.equal(job.ats, 'greenhouse');
    assert.equal(job.applyUrl, 'https://job-boards.greenhouse.io/acme/jobs/1');
    assert.equal(job.salary?.min, 36000);
    assert.equal(job.employmentType, 'full-time');
    assert.equal(job.postedAt, '2026-11-10T00:00:00.000Z');
    assert.equal(job.description, 'Join us.\n\nSalary €36,000 - €40,000 per annum');
    assert.equal(job.id, norm.jobId('Acme', 'PR Executive', 'Dublin, Ireland'));
  });
});

// ───────────────────────────── ATS adapters (fixtures) ─────────────────────────────

describe('adapters', () => {
  test('greenhouse: title + location pre-filter, absolute_url, atsMeta', async () => {
    const http = new StubHttp([{ match: (u) => u.startsWith('https://boards-api.greenhouse.io/v1/boards/flipdish/jobs'), body: fixture('greenhouse.json') }]);
    const jobs = await greenhouse.fetch(ctxFor(http, { companies: [company('Flipdish', 'greenhouse', 'flipdish')] }));
    assert.equal(http.calls[0].url, 'https://boards-api.greenhouse.io/v1/boards/flipdish/jobs?content=true');
    // 4 jobs: 2 marketing (Dublin, London) pass; Field SDR fails the title filter; Karachi support fails both.
    assert.deepEqual(jobs.map((j) => j.location), ['Ireland - Dublin Hub (Hybrid)', 'United Kingdom - London (Hybrid)']);
    const j = jobs[0];
    assert.equal(j.source, 'greenhouse');
    assert.equal(j.applyUrl, 'https://job-boards.eu.greenhouse.io/flipdish/jobs/5011114101');
    assert.deepEqual([j.atsMeta?.boardToken, j.atsMeta?.jobId], ['flipdish', 5011114101]);
    const n = norm.normalizeJob(j);
    assert.equal(n.ats, 'greenhouse');
    assert.equal(n.country, 'IE');
    assert.ok(n.description.length > 200 && !n.description.includes('&lt;') && !n.description.includes('<'));
  });

  test('lever: hostedUrl + /apply, IE country appended, title filter', async () => {
    const http = new StubHttp([{ match: (u) => u.startsWith('https://api.lever.co/v0/postings/cartrawler'), body: fixture('lever.json') }]);
    const jobs = await lever.fetch(ctxFor(http, { companies: [company('CarTrawler', 'lever', 'cartrawler')] }));
    assert.equal(jobs.length, 1);
    const j = jobs[0];
    assert.equal(j.title, 'Head of Marketing & Communications - Fixed-Term Contract');
    assert.equal(j.location, 'Dublin, Ireland');
    assert.equal(j.applyUrl, 'https://jobs.lever.co/cartrawler/64b995f9-75b1-4b5d-a4cb-f23f84c88989/apply');
    assert.deepEqual([j.atsMeta?.company, j.atsMeta?.postingId], ['cartrawler', '64b995f9-75b1-4b5d-a4cb-f23f84c88989']);
    assert.equal(j.remote, false);
    assert.ok(norm.normalizeJob(j).description.includes('- '), 'lists become bullet lines');
  });

  test('lever: falls back to the EU API host on 404', async () => {
    const http = new StubHttp([{ match: (u) => u.startsWith('https://api.eu.lever.co/v0/postings/cartrawler'), body: fixture('lever.json') }]);
    const jobs = await lever.fetch(ctxFor(http, { companies: [company('CarTrawler', 'lever', 'cartrawler')] }));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].atsMeta?.apiHost, 'https://api.eu.lever.co');
  });

  test('ashby: UK/Dublin + remote-Europe pass, US-only/Nordics dropped, jobUrl/applyUrl captured', async () => {
    const http = new StubHttp([{ match: (u) => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/ElevenLabs'), body: fixture('ashby.json') }]);
    const jobs = await ashby.fetch(ctxFor(http, { companies: [company('ElevenLabs', 'ashby', 'ElevenLabs')] }));
    assert.ok(http.calls[0].url.endsWith('?includeCompensation=true'));
    // Commercial Counsel fails the title filter; B2B Marketing is Sweden-only; Influencer Marketer lists Europe as a secondary location.
    assert.deepEqual(jobs.map((j) => j.title), ['Product Marketing - Agents - Government', 'Influencer Marketer']);
    assert.equal(norm.normalizeJob(jobs[1]).country, 'REMOTE');
    const j = jobs[0];
    assert.equal(j.remote, true);
    assert.equal(j.url, 'https://jobs.ashbyhq.com/ElevenLabs/33bb01d0-993c-47fa-ae91-81c0c84f367e');
    assert.equal(j.applyUrl, 'https://jobs.ashbyhq.com/ElevenLabs/33bb01d0-993c-47fa-ae91-81c0c84f367e/application');
    assert.deepEqual([j.atsMeta?.jobBoardName, j.atsMeta?.jobPostingId], ['ElevenLabs', '33bb01d0-993c-47fa-ae91-81c0c84f367e']);
    assert.equal(norm.normalizeJob(j).country, 'IE', 'Dublin is one of its secondary locations');
  });

  test('smartrecruiters: per-country list, title filter before detail fetch, applyUrl from detail', async () => {
    const http = new StubHttp([
      { match: (u) => u.includes('/companies/Primark/postings?') && u.includes('country=ie'), body: fixture('smartrecruiters_list_ie.json') },
      { match: (u) => u.includes('/companies/Primark/postings?') && u.includes('country=gb'), body: '{"offset":0,"limit":100,"totalFound":0,"content":[]}' },
      { match: (u) => u.endsWith('/companies/Primark/postings/744000160890019'), body: fixture('smartrecruiters_detail.json') },
    ]);
    const jobs = await smartrecruiters.fetch(ctxFor(http, { companies: [company('Primark', 'smartrecruiters', 'Primark')] }));
    assert.equal(jobs.length, 1, 'retail assistant roles are filtered out');
    assert.equal(http.calls.filter((c) => /postings\/\d+$/.test(c.url)).length, 1, 'only the match gets a detail fetch');
    const j = jobs[0];
    assert.equal(j.title, 'VM Communications Coordinator & Stylist');
    assert.equal(j.location, 'Dublin, Ireland');
    assert.equal(j.applyUrl, 'https://jobs.smartrecruiters.com/Primark/744000160890019-vm-communications-coordinator-stylist?oga=true');
    assert.deepEqual([j.atsMeta?.companyIdentifier, j.atsMeta?.postingId], ['Primark', '744000160890019']);
    assert.ok(norm.normalizeJob(j).description.length > 200);
  });

  test('smartrecruiters: public URL fallback when detail fails', async () => {
    const http = new StubHttp([
      { match: (u) => u.includes('country=ie'), body: fixture('smartrecruiters_list_ie.json') },
      { match: (u) => u.includes('country=gb'), body: '{"content":[]}' },
    ]);
    const jobs = await smartrecruiters.fetch(ctxFor(http, { companies: [company('Primark', 'smartrecruiters', 'Primark')] }));
    assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/Primark/744000160890019');
  });

  test('workable: application_url, shortcode in atsMeta, non-IE remote dropped', async () => {
    const http = new StubHttp([{ match: (u) => u.startsWith('https://apply.workable.com/api/v1/widget/accounts/thepeoplegroup'), body: fixture('workable.json') }]);
    const jobs = await workable.fetch(ctxFor(http, { companies: [company('The People Group', 'workable', 'thepeoplegroup')], titleMustMatch: [] }));
    assert.deepEqual(jobs.map((j) => j.title), ['Marketing & Communications Executive']);
    const j = jobs[0];
    assert.equal(j.applyUrl, 'https://apply.workable.com/j/B7C2D19E44/apply');
    assert.deepEqual([j.atsMeta?.account, j.atsMeta?.shortcode], ['thepeoplegroup', 'B7C2D19E44']);
    const n = norm.normalizeJob(j);
    assert.equal(n.location, 'Dublin, County Dublin, Ireland');
    assert.equal(n.salary?.min, 35000);
    assert.equal(n.ats, 'workable');
  });

  test('one broken board does not sink the adapter; all broken throws', async () => {
    const http = new StubHttp([{ match: (u) => u.includes('/boards/flipdish/'), body: fixture('greenhouse.json') }]);
    const ok = await greenhouse.fetch(ctxFor(http, { companies: [company('Gone', 'greenhouse', 'gone'), company('Flipdish', 'greenhouse', 'flipdish')] }));
    assert.equal(ok.length, 2);
    await assert.rejects(greenhouse.fetch(ctxFor(new StubHttp([]), { companies: [company('Gone', 'greenhouse', 'gone')] })), /all 1 greenhouse boards failed/);
  });

  test('adzuna: enabled without keys degrades to [] with no requests', async () => {
    const http = new StubHttp([]);
    const jobs = await adzuna.fetch(ctxFor(http, { adzuna: { enabled: true, queries: [{ what: 'marketing', where: 'Dublin', country: 'ie' }] } }));
    assert.deepEqual(jobs, []);
    assert.equal(http.calls.length, 0);
  });
});

// ───────────────────────────── LinkedIn guest ─────────────────────────────

describe('linkedinGuest', () => {
  test('parses search cards', () => {
    const cards = li.parseSearchPage(fixture('linkedin_search.html'));
    assert.equal(cards.length, 3);
    assert.equal(cards[0].id, '4489934678');
    assert.equal(cards[0].title, 'Marketing Executive');
    assert.ok(cards[0].company.length > 1);
    assert.equal(cards[0].url, 'https://www.linkedin.com/jobs/view/4489934678');
  });

  test('parses a detail page (easy-apply style, no external URL)', () => {
    const d = li.parseJobPosting(fixture('linkedin_detail.html'));
    assert.equal(d.title, 'Marketing Executive');
    assert.ok((d.descriptionHtml ?? '').length > 200);
    assert.equal(d.applyUrl, undefined);
    assert.equal(d.closed, false);
  });

  test('extracts and decodes the external apply URL so the real ATS is detected', () => {
    const d = li.parseJobPosting(fixture('linkedin_detail_external.html'));
    assert.equal(d.applyUrl, 'https://job-boards.eu.greenhouse.io/acmeireland/jobs/4512345101');
    assert.equal(d.company, 'Acme Ireland');
    assert.equal(d.location, 'Dublin, County Dublin, Ireland');
    assert.equal(d.criteria['employment type'], 'Full-time');
    const raw = li.buildLinkedInJob({ id: '4090000123', title: 'Communications Executive', company: 'Acme Ireland', location: 'Dublin, County Dublin, Ireland', url: li.jobViewUrl('4090000123') }, d);
    const n = norm.normalizeJob(raw);
    assert.equal(n.ats, 'greenhouse');
    assert.equal(n.url, 'https://www.linkedin.com/jobs/view/4090000123');
    assert.equal(n.salary?.min, 38000);
    assert.equal(n.employmentType, 'full-time');
  });

  test('adapter: ≥3 s spacing, guest URLs only, filters by title, fetches detail', async () => {
    const http = new StubHttp([
      { match: (u) => u.includes('/seeMoreJobPostings/search') && u.includes('start=0'), body: fixture('linkedin_search.html') },
      { match: (u) => u.includes('/seeMoreJobPostings/search'), body: '' },
      { match: (u) => u.includes('/jobs-guest/jobs/api/jobPosting/'), body: fixture('linkedin_detail.html') },
    ]);
    const cfg = { enabled: true, queries: [{ keywords: 'marketing executive', location: 'Ireland' }], maxPerQuery: 50, minIntervalMs: 1000 };
    const jobs = await li.linkedinGuest.fetch(ctxFor(http, { linkedinGuest: cfg }));
    assert.ok(jobs.length >= 1);
    for (const c of http.calls) {
      assert.match(c.url, /^https:\/\/www\.linkedin\.com\/jobs-guest\/jobs\/api\//);
      assert.ok((c.minIntervalMs ?? 0) >= 3000);
    }
    const search = new URL(http.calls[0].url);
    assert.equal(search.searchParams.get('f_TPR'), 'r604800');
    assert.equal(search.searchParams.get('f_E'), '1,2,3');
    assert.equal(jobs[0].source, 'linkedin_guest');
    assert.equal(jobs[0].atsMeta?.detailFetched, true);
  });

  test('adapter: stops everything after a 429', async () => {
    const http = new StubHttp([{ match: () => true, status: 429, body: '' }]);
    const cfg = { enabled: true, queries: [{ keywords: 'a', location: 'Ireland' }, { keywords: 'b', location: 'Ireland' }], maxPerQuery: 50, minIntervalMs: 3000 };
    const warnings: string[] = [];
    const jobs = await li.linkedinGuest.fetch({ ...ctxFor(http, { linkedinGuest: cfg }), log: { ...silentLog, warn: (m: string) => warnings.push(m) } });
    assert.deepEqual(jobs, []);
    assert.equal(http.calls.length, 1);
    assert.match(warnings[0], /backing off/);
  });

  test('adapter: an authwall redirect also stops the run', async () => {
    const http = new StubHttp([{ match: () => true, body: '<html>sign in</html>', finalUrl: 'https://www.linkedin.com/authwall?trk=x' }]);
    const cfg = { enabled: true, queries: [{ keywords: 'a', location: 'Ireland' }, { keywords: 'b', location: 'Ireland' }], maxPerQuery: 50, minIntervalMs: 3000 };
    assert.deepEqual(await li.linkedinGuest.fetch(ctxFor(http, { linkedinGuest: cfg })), []);
    assert.equal(http.calls.length, 1);
  });
});

// ───────────────────────────── Gmail alerts ─────────────────────────────

describe('gmailAlerts.parseAlertEmail', () => {
  const brief = (jobs: RawJob[]) => jobs.map((j) => ({ sourceId: j.sourceId, title: j.title, company: j.company, location: j.location, url: j.url }));

  test('LinkedIn HTML alert', () => {
    const jobs = parseAlertEmail(email('linkedin_alert.html', 'jobalerts-noreply@linkedin.com'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'linkedin:4071234567', title: 'Marketing Executive', company: 'Emerald Airlines', location: 'Dublin, County Dublin, Ireland', url: 'https://www.linkedin.com/jobs/view/4071234567' },
      { sourceId: 'linkedin:4071299001', title: 'Communications & PR Executive', company: 'Ornua', location: 'Dundalk, County Louth, Ireland', url: 'https://www.linkedin.com/jobs/view/4071299001' },
      { sourceId: 'linkedin:4071300555', title: 'Social Media Executive', company: 'Sharp Media', location: 'Belfast, Northern Ireland, United Kingdom', url: 'https://www.linkedin.com/jobs/view/4071300555' },
    ]);
    assert.equal(jobs[0].source, 'gmail_alert');
    assert.equal(jobs[1].salaryText, '€36,000 - €42,000 / year');
    assert.equal(jobs[2].remote, true);
    assert.equal(jobs[0].atsMeta?.alertMessageId, '<linkedin_alert.html@test>');
  });

  test('LinkedIn plain-text alert', () => {
    const jobs = parseAlertEmail(email('linkedin_alert.txt', 'jobs-noreply@linkedin.com'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'linkedin:4072000111', title: 'Communications Officer', company: 'Louth County Council', location: 'Dundalk, County Louth, Ireland', url: 'https://www.linkedin.com/jobs/view/4072000111' },
      { sourceId: 'linkedin:4072000222', title: 'Junior PR Account Executive', company: 'Wilson Hartnell', location: 'Dublin, County Dublin, Ireland', url: 'https://www.linkedin.com/jobs/view/4072000222' },
    ]);
  });

  test('Indeed alert (rc/clk, tracking host, viewjob links)', () => {
    const jobs = parseAlertEmail(email('indeed_alert.html', 'alert@indeed.com'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'indeed:4f2a9c1b7e3d5a60', title: 'Digital Marketing Executive', company: 'Brandwell Agency', location: 'Dublin, County Dublin', url: 'https://ie.indeed.com/viewjob?jk=4f2a9c1b7e3d5a60' },
      { sourceId: 'indeed:9b8c7d6e5f4a3b21', title: 'Marketing Assistant (Graduate)', company: 'Fresh Foods Ireland Ltd', location: 'Drogheda, County Louth', url: 'https://ie.indeed.com/viewjob?jk=9b8c7d6e5f4a3b21' },
      { sourceId: 'indeed:0a1b2c3d4e5f6a7b', title: 'Content & Social Media Coordinator', company: 'Harbour Arts Centre', location: 'Remote', url: 'https://ie.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b' },
    ]);
    assert.equal(norm.normalizeJob(jobs[1]).salary?.min, Math.round(16.5 * 1950));
  });

  test('IrishJobs.ie alert', () => {
    const jobs = parseAlertEmail(email('irishjobs_alert.html', 'alerts@irishjobs.ie'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'irishjobs:105012345', title: 'Communications Officer', company: 'Dundalk Institute of Technology', location: 'Dundalk, Louth', url: 'https://www.irishjobs.ie/job/communications-officer/dundalk-institute-of-technology-job105012345' },
      { sourceId: 'irishjobs:105099876', title: 'PR Executive', company: 'FleishmanHillard', location: 'Dublin City Centre, Dublin', url: 'https://www.irishjobs.ie/job/pr-executive/fleishmanhillard-job105099876' },
    ]);
    assert.equal(jobs[0].salaryText, '€38,000 - €44,000');
  });

  test('Jobs.ie plain-text alert', () => {
    const jobs = parseAlertEmail(email('jobsie_alert.txt', 'alerts@jobs.ie'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'jobsie:2345678', title: 'Marketing Coordinator', company: 'Peninsula Hotels Group', location: 'Newry, Co. Down', url: 'https://www.jobs.ie/job/marketing-coordinator/peninsula-hotels-group-job2345678' },
      { sourceId: 'jobsie:2345999', title: 'Events and Marketing Executive', company: 'Louth Sports Partnership', location: 'Dundalk, Co. Louth', url: 'https://www.jobs.ie/job/events-and-marketing-executive/louth-sports-partnership-job2345999' },
    ]);
    assert.equal(norm.normalizeJob(jobs[0]).country, 'GB-NIR');
    assert.equal(norm.normalizeJob(jobs[0]).salary?.currency, 'GBP');
  });

  test('Glassdoor alert: company above title, board estimates ignored', () => {
    const jobs = parseAlertEmail(email('glassdoor_alert.html', 'noreply@glassdoor.com'));
    assert.deepEqual(brief(jobs), [
      { sourceId: 'glassdoor:1009512345678', title: 'Brand Marketing Executive', company: 'Kerry Group', location: 'Naas', url: 'https://www.glassdoor.ie/job-listing/j?jl=1009512345678' },
      { sourceId: 'glassdoor:1009598765432', title: 'Content Executive', company: 'Bord Bia', location: 'Dublin', url: 'https://www.glassdoor.ie/job-listing/content-executive-bord-bia-JV_IC2739035_KO0,17_KE18,26.htm?jl=1009598765432' },
    ]);
    assert.equal(jobs[0].salaryText, '€38K - €45K (Employer est.)');
    assert.equal(jobs[1].salaryText, undefined, '"Glassdoor est." is not an employer figure');
  });

  test('non-alert mail and junk input return []', () => {
    assert.deepEqual(parseAlertEmail({ messageId: '<x>', from: 'a@b.ie', fromAddress: 'a@b.ie', subject: 'Hi', date: '', text: 'Lunch on Friday? https://example.com' }), []);
    assert.deepEqual(parseAlertEmail({ messageId: '<y>', from: '', fromAddress: '', subject: '', date: '', text: '', html: '<a href="javascript:alert(1)">x</a>' }), []);
  });

  test('parseJobLink unwraps redirect wrappers', () => {
    const wrapped = `https://click.example.com/r?url=${encodeURIComponent('https://www.linkedin.com/comm/jobs/view/4071234567/?trk=x')}`;
    assert.equal(parseJobLink(wrapped)?.url, 'https://www.linkedin.com/jobs/view/4071234567');
  });
});

// ───────────────────────────── runDiscovery ─────────────────────────────

describe('runDiscovery', () => {
  const fixedAdapter = (id: 'greenhouse' | 'lever', jobs: RawJob[]) => ({ id, label: id, fetch: async () => jobs });
  const raw = (over: Partial<RawJob> = {}): RawJob => ({
    source: 'greenhouse', sourceId: '1', company: 'Acme', title: 'Marketing Executive', location: 'Dublin, Ireland',
    url: 'https://job-boards.greenhouse.io/acme/jobs/1', descriptionHtml: '<p>Role</p>', ...over,
  });
  const cfg = sources({ companies: [company('Acme', 'greenhouse', 'acme'), company('Beta', 'lever', 'beta')] });

  test('normalises, upserts, counts per source, isolates failures, records kv + event', async () => {
    const broken = { id: 'lever' as const, label: 'lever', fetch: async (): Promise<RawJob[]> => { throw new Error('boom'); } };
    const input = { sources: cfg, profile: PROFILE, http: new StubHttp([]), log: silentLog };
    const adapters = [fixedAdapter('greenhouse', [raw(), raw({ sourceId: '2', title: 'PR Executive' })]), broken];

    const first = await runDiscovery(input, { adapters });
    assert.equal(first.found, 2);
    assert.equal(first.created, 2);
    assert.deepEqual([first.bySource.greenhouse?.found, first.bySource.greenhouse?.created], [2, 2]);
    assert.equal(first.bySource.lever?.error, 'boom');

    const second = await runDiscovery(input, { adapters });
    assert.equal(second.created, 0, 'second run creates nothing new');
    assert.equal(second.found, 2);

    const stored = dbm.listJobs({ source: 'greenhouse' });
    assert.equal(stored.length, 2);
    assert.ok(stored.every((j) => j.status === 'discovered' && j.country === 'IE' && j.ats === 'greenhouse'));
    const last = dbm.kvGet<{ found: number; at: string }>('source.greenhouse.lastRun');
    assert.equal(last?.found, 2);
    assert.ok(last?.at);
    assert.equal(dbm.kvGet<{ error: string }>('source.lever.lastRun')?.error, 'boom');
    assert.ok(dbm.listEvents({ type: 'discovery.run' }).length >= 2);
  });

  test('skips sources with nothing configured and honours `only` + `since`', async () => {
    const input = { sources: sources({ companies: [company('Acme', 'greenhouse', 'acme')] }), profile: PROFILE, http: new StubHttp([]), log: silentLog, since: '2026-11-01T00:00:00.000Z' };
    const res = await runDiscovery(input, {
      adapters: [fixedAdapter('greenhouse', [raw({ sourceId: '9', title: 'Old Marketing Role', postedAt: '2026-01-01' }), raw({ sourceId: '10', title: 'Brand Executive', postedAt: '2026-11-10' })]), fixedAdapter('lever', [raw()])],
    });
    assert.equal(res.bySource.greenhouse?.found, 1, 'postings older than `since` are dropped');
    assert.equal(res.bySource.lever?.skipped, 'no enabled companies');
    const only = await runDiscovery(input, { adapters: [fixedAdapter('greenhouse', [])], only: ['lever'] });
    assert.deepEqual(only.bySource, {});
  });

  test('ADAPTERS covers every pull source', () => {
    assert.deepEqual(ADAPTERS.map((a) => a.id).sort(), ['adzuna', 'ashby', 'board_search', 'greenhouse', 'lever', 'linkedin_guest', 'smartrecruiters', 'workable']);
  });
});
