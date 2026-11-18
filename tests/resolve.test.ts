// Apply-target resolver tests: matching rules (incl. near-miss negatives), LinkedIn easy-apply detection,
// board/search parsers against saved fixtures, agency e-mail extraction, and the DB flow against a temp
// DB with a stub HTTP layer. No network: every request goes to a fixture-backed stub fetch.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-resolve-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'resolve.db');

const m = await import('../src/engine/resolve/match');
const li = await import('../src/engine/resolve/linkedin');
const ats = await import('../src/engine/resolve/ats');
const wd = await import('../src/engine/resolve/workday');
const search = await import('../src/engine/resolve/search');
const page = await import('../src/engine/resolve/page');
const agency = await import('../src/engine/resolve/agency');
const { createResolverHttp } = await import('../src/engine/resolve/http');
const { resolveApplyTargets, selectJobs } = await import('../src/engine/resolve/index');
const dbm = await import('../src/lib/db');
const { normalizeJob } = await import('../src/engine/sources/normalize');

type RawJob = import('../src/lib/types').RawJob;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'resolve');
const fx = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── stub network ─────────────────────────────

type Route = { match: RegExp; status?: number; body: string; url?: string; method?: 'GET' | 'POST' };

function stubFetch(routes: Route[], log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    log.push(`${method} ${url}`);
    const r = routes.find((x) => x.match.test(url) && (!x.method || x.method === method));
    const res = new Response(r ? r.body : 'not found', { status: r ? r.status ?? 200 : 404, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(res, 'url', { value: r?.url ?? url });
    return res;
  }) as typeof fetch;
}

const noWait = { intervalFor: () => 0, sleep: async () => undefined };

// ───────────────────────────── titles ─────────────────────────────

describe('title matching', () => {
  test('exact after cleaning: locations, codes, brackets, company tails', () => {
    assert.ok(m.titlesMatch('Digital Marketing Executive - Dublin 15', 'Digital Marketing Executive'));
    assert.ok(m.titlesMatch('Communications Executive (Fixed Term - 11 months)', 'Communications Executive'));
    assert.ok(m.titlesMatch('Marketing Executive – Content & Digital Marketing | CCS1259', 'Marketing Executive - Content and Digital Marketing'));
    assert.ok(m.titlesMatch('Customer / Marketing Internship Programme - Tesco Ireland', 'Customer/Marketing Internship Program', 'Tesco Ireland'));
    assert.ok(m.titlesMatch('PR Executive', 'Public Relations Executive'));
    assert.ok(m.titlesMatch('Event Co-ordinator', 'Events Coordinator'));
    assert.ok(m.titlesMatch('Marketing and Communications Intern', 'Marketing & Communications Internship'));
  });

  test('near misses are rejected', () => {
    assert.equal(m.titlesMatch('Senior PR Executive', 'PR Executive'), false);
    assert.equal(m.titlesMatch('PR Executive', 'Senior PR Executive'), false);
    assert.equal(m.titlesMatch('Digital Marketing Executive', 'Senior Digital Marketing Executive'), false); // Jaccard 0.75 but seniority differs
    assert.equal(m.titlesMatch('Events Coordinator', 'Facilities & Events Coordinator'), false);
    assert.equal(m.titlesMatch('Marketing Executive', 'Marketing Manager'), false);
    assert.equal(m.titlesMatch('Marketing Executive', 'Marketing Executive Intern'), false);
    assert.equal(m.titlesMatch('Social Media Executive', 'Social Media Manager'), false);
  });

  test('similarity is a token Jaccard', () => {
    const s = m.titleSimilarity('Groups, Conferences & Events Executive', 'Groups Conferences and Events Executive');
    assert.equal(s.score, 1);
    assert.ok(m.titleSimilarity('Marketing Executive', 'Digital Marketing Executive').score < 0.75);
  });
});

// ───────────────────────────── companies + slugs ─────────────────────────────

describe('company identity and slugs', () => {
  test('slug derivation strips suffixes and taglines, caps at 6', () => {
    assert.deepEqual(m.companySlugs("Ryanair - Europe's Favourite Airline").map((s) => s.slug), ['ryanair']);
    const dalata = m.companySlugs('Dalata Hotel Group').map((s) => s.slug);
    assert.ok(dalata.includes('dalatahotel') && dalata.includes('dalata-hotel') && dalata.includes('dalatahotelgroup'));
    assert.ok(dalata.length <= 6);
    const fsai = m.companySlugs('Food Safety Authority of Ireland').map((s) => s.slug);
    assert.ok(fsai.includes('fsai') && fsai.includes('foodsafetyauthority'));
    assert.deepEqual(m.companySlugs('Acme Ireland Limited').map((s) => s.slug).slice(0, 1), ['acme']);
    assert.ok(m.companySlugs('Search Talent', ['search-talent']).some((s) => s.slug === 'searchtalent'));
    assert.equal(m.companySlugs('Enterprise')[0].weak, true, 'a common word is a weak slug');
    assert.equal(m.companySlugs('Cpl')[0].weak, true, 'a 3-letter slug is weak');
  });

  test('company matching', () => {
    assert.ok(m.companyMatches('Microchip Technology Inc.', 'Microchip - International'));
    assert.ok(m.companyMatches("Ryanair - Europe's Favourite Airline", 'Ryanair Group Holdings'));
    assert.ok(m.companyMatches('Tata Consultancy Services', 'TCS'));
    assert.ok(m.companyMatches('Cushman & Wakefield', 'Cushman and Wakefield'));
    assert.equal(m.companyMatches('Virgin Media Ireland', 'Media Group'), false);
    assert.equal(m.companyMatches('Search Talent', 'Talent Search Partners'), false);
    assert.equal(m.companyMatches('Microchip Technology', 'Microsoft'), false);
  });

  test('host ownership', () => {
    assert.ok(m.hostMatchesCompany('careers.dalatahotelgroup.com', 'Dalata Hotel Group'));
    assert.ok(m.hostMatchesCompany('careers.ryanair.com', "Ryanair - Europe's Favourite Airline"));
    assert.ok(m.hostMatchesCompany('joinus.focusireland.ie', 'Focus Ireland'));
    assert.equal(m.hostMatchesCompany('www.focus.com', 'Focus Ireland'), false);
    assert.equal(m.hostMatchesCompany('www.microsoft.com', 'Microchip Technology'), false);
  });
});

// ───────────────────────────── locations ─────────────────────────────

describe('location compatibility', () => {
  const dublin = { location: 'Dublin, County Dublin, Ireland' };
  test('same city / country / remote-Europe are compatible', () => {
    assert.equal(m.locationVerdict(dublin, 'Dublin, Ireland'), 'compatible');
    assert.equal(m.locationVerdict(dublin, 'Swords, Co. Dublin'), 'compatible');
    assert.equal(m.locationVerdict(dublin, 'Ireland'), 'compatible');
    assert.equal(m.locationVerdict(dublin, 'Remote - Europe'), 'compatible');
    assert.equal(m.locationVerdict({ location: 'Ennis, County Clare, Ireland' }, 'Ireland - Dublin (MCHP) / Ireland - Ennis'), 'compatible');
    assert.equal(m.locationVerdict({ location: 'Ireland' }, 'Dublin'), 'compatible');
  });
  test('different city or country is incompatible; vague is unknown', () => {
    assert.equal(m.locationVerdict(dublin, 'Cork, Ireland'), 'incompatible');
    assert.equal(m.locationVerdict(dublin, 'London, UK'), 'incompatible');
    assert.equal(m.locationVerdict(dublin, 'Remote - US'), 'incompatible');
    assert.equal(m.locationVerdict(dublin, '2 Locations'), 'unknown');
    assert.equal(m.locationVerdict(dublin, ''), 'unknown');
  });
});

describe('judge: low-confidence matches are rejected', () => {
  const job = { title: 'PR Executive', company: 'Acme Communications', location: 'Dublin, Ireland' };
  test('accepts a clean match', () => {
    const v = m.judge(job, { title: 'PR Executive', location: 'Dublin' }, 'api_name');
    assert.equal(v.ok, true);
    assert.equal(v.confidence, 1);
  });
  test('rejects without company evidence, near-miss titles, other cities', () => {
    assert.equal(m.judge(job, { title: 'PR Executive', location: 'Dublin' }, undefined).ok, false);
    assert.equal(m.judge(job, { title: 'Senior PR Executive', location: 'Dublin' }, 'api_name').ok, false);
    assert.equal(m.judge(job, { title: 'PR Executive', location: 'Cork, Ireland' }, 'api_name').ok, false);
  });
  test('unknown location needs strong company evidence; weak slugs need an exact title', () => {
    assert.equal(m.judge(job, { title: 'PR Executive' }, 'api_name').ok, true);
    assert.equal(m.judge(job, { title: 'PR Executive' }, 'slug').ok, false);
    assert.equal(m.judge(job, { title: 'PR Executive' }, 'page_text').ok, false);
    const close = { title: 'PR and Media Executive', company: 'Enterprise', location: 'Dublin' };
    assert.equal(m.judge(close, { title: 'PR & Media Executive (Dublin)', location: 'Dublin' }, 'slug', { weakSlug: true }).ok, true);
    assert.equal(m.judge({ ...close, title: 'Graduate PR Media Executive Program' }, { title: 'Graduate PR Media Executive', location: 'Dublin' }, 'slug', { weakSlug: true }).ok, false);
  });
});

// ───────────────────────────── LinkedIn ─────────────────────────────

describe('LinkedIn guest page', () => {
  test('Easy Apply vs offsite from saved guest pages', () => {
    const easy = li.parseLinkedInApply(fx('linkedin_easy_apply.html'));
    assert.equal(easy.mode, 'easy_apply');
    assert.equal(easy.closed, false);
    assert.equal(easy.companySlug, 'search-talent');
    const off = li.parseLinkedInApply(fx('linkedin_offsite.html'));
    assert.equal(off.mode, 'offsite');
    assert.equal(off.companySlug, 'ryanair');
    assert.equal(off.title, 'PR and Communications Executive');
    assert.equal(li.detectApplyMode('<html><body>nothing here</body></html>'), 'unknown');
  });
  test('job id from atsMeta or URL', () => {
    assert.equal(li.linkedInJobId({ atsMeta: { linkedinJobId: '4470314742' } }), '4470314742');
    assert.equal(li.linkedInJobId({ url: 'https://www.linkedin.com/jobs/view/pr-exec-at-acme-4490766237' }), '4490766237');
  });
});

// ───────────────────────────── boards ─────────────────────────────

describe('board parsers (real trimmed responses)', () => {
  test('greenhouse / lever / ashby / smartrecruiters / workable', () => {
    const gh = ats.parseGreenhouseJobs(JSON.parse(fx('greenhouse_tines.json')), 'tines');
    assert.ok(gh.length >= 3 && gh[0].company === 'Tines' && gh[0].applyUrl?.startsWith('https://job-boards.greenhouse.io/tines/jobs/'));
    const lv = ats.parseLeverPostings(JSON.parse(fx('lever_websummit.json')), 'websummit');
    assert.equal(lv.length, 3);
    assert.match(lv[0].location, /Dublin/);
    assert.match(lv[0].applyUrl ?? '', /\/apply$/);
    const ab = ats.parseAshbyBoard(JSON.parse(fx('ashby_notion.json')), 'notion');
    assert.ok(ab.length >= 2 && ab.every((p) => p.url.startsWith('https://jobs.ashbyhq.com/notion/')));
    const sr = ats.parseSmartRecruitersList(JSON.parse(fx('smartrecruiters_ryanair.json')), 'ryanairgroupholdings');
    const pr = sr.find((p) => p.title === 'PR and Communications Executive');
    assert.ok(pr);
    assert.equal(pr.company, 'Ryanair Group Holdings');
    assert.match(pr.location, /Swords/);
    assert.equal(pr.url, 'https://jobs.smartrecruiters.com/RyanairGroupHoldings/744000151798952');
    assert.equal(ats.parseSmartRecruitersList(JSON.parse(fx('smartrecruiters_missing.json')), 'x').length, 0);
    const detail = ats.parseSmartRecruitersDetail(JSON.parse(fx('smartrecruiters_ryanair_detail.json')), 'RyanairGroupHoldings');
    assert.match(detail?.applyUrl ?? '', /oga=true/);
    const wk = ats.parseWorkableWidget(JSON.parse(fx('workable_thepeoplegroup.json')), 'thepeoplegroup');
    assert.ok(wk.length >= 1 && wk[0].company === 'The People Group');
  });
  test('teamtailor / personio / recruitee / bamboohr', () => {
    const tt = ats.parseTeamtailorJobs(fx('teamtailor_career.html'), 'career');
    assert.equal(tt.length, 3);
    assert.equal(tt[0].title, 'Customer Success Manager - French Speaking');
    assert.match(tt[0].location, /Stockholm/);
    const px = ats.parsePersonioXml(fx('personio_ottonova.xml'), 'ottonova');
    assert.equal(px.length, 2);
    assert.match(px[0].location, /München/);
    assert.equal(px[0].url, `https://ottonova.jobs.personio.de/job/${px[0].postingId}`);
    const rc = ats.parseRecruiteeOffers(JSON.parse(fx('recruitee_bunq.json')), 'bunq');
    assert.ok(rc.length === 2 && rc[0].company === 'bunq');
    const bb = ats.parseBambooHrList(JSON.parse(fx('bamboohr_list.json')), 'acme');
    assert.equal(bb[0].url, 'https://acme.bamboohr.com/careers/41');
    assert.match(bb[0].location, /Dublin, Ireland/);
    assert.equal(ats.parseBambooHrList(JSON.parse(fx('bamboohr_empty.json')), 'x').length, 0);
  });
  test('workday search + detail', () => {
    const site = wd.parseWorkdayUrl('https://wd5.myworkdaysite.com/en-US/recruiting/microchiphr/External');
    assert.deepEqual(site && { tenant: site.tenant, site: site.site }, { tenant: 'microchiphr', site: 'External' });
    assert.equal(wd.parseWorkdayUrl('https://cw.wd1.myworkdayjobs.com/en-US/External/job/Dublin/Events_R1')?.site, 'External');
    const list = wd.parseWorkdayList(JSON.parse(fx('workday_microchip_list.json')));
    assert.equal(list[0].title, 'Centralized Marketing Specialist');
    const d = wd.parseWorkdayDetail(JSON.parse(fx('workday_microchip_detail.json')), site!, list[0].externalPath);
    assert.match(d?.location ?? '', /Dublin.*Ennis/);
    assert.equal(d?.company, 'Microchip - International');
  });
  test('ATS identifiers use the discovery adapters\' atsMeta keys', async () => {
    const { atsIdentifiers } = await import('../src/engine/resolve/index');
    assert.deepEqual(atsIdentifiers('greenhouse', 'tines', '6222429004'), { boardToken: 'tines', jobId: 6222429004 });
    assert.deepEqual(atsIdentifiers('lever', 'websummit', 'abc'), { company: 'websummit', postingId: 'abc' });
    assert.deepEqual(atsIdentifiers('workable', 'mm-coaching-limited', '52E2A9AE08'), { account: 'mm-coaching-limited', shortcode: '52E2A9AE08' });
    assert.deepEqual(atsIdentifiers('company'), {});
  });

  test('URL classification', () => {
    assert.deepEqual(ats.classifyUrl('https://jobs.smartrecruiters.com/RyanairGroupHoldings/744000151798952-pr-and-communications-executive'), { kind: 'smartrecruiters', slug: 'RyanairGroupHoldings', postingId: '744000151798952' });
    assert.equal(ats.classifyUrl('https://jobs.lever.co/websummit/396e74b8-6e8a-48e9-87a2-d45c08b68190/apply').postingId, '396e74b8-6e8a-48e9-87a2-d45c08b68190');
    assert.equal(ats.classifyUrl('https://job-boards.eu.greenhouse.io/acme/jobs/4512345101').slug, 'acme');
    assert.equal(ats.classifyUrl('https://ie.indeed.com/viewjob?jk=1').kind, 'indeed');
    assert.equal(ats.classifyUrl('https://www.glassdoor.ie/job-listing/x').kind, 'board');
    assert.equal(ats.classifyUrl('https://careers.dalatahotelgroup.com/x-317101.htm').kind, 'unknown');
  });
});

// ───────────────────────────── search ─────────────────────────────

describe('search result parsing', () => {
  test('DuckDuckGo direct and uddg links', () => {
    const r = search.parseDuckDuckGoHtml(fx('ddg_results.html'));
    assert.equal(r.length, 4);
    assert.match(r[0].url, /^https:\/\/ie\.linkedin\.com\/jobs\/view\//);
    assert.ok(r[0].title.includes('Centralized Marketing Specialist'));
    const g = search.parseDuckDuckGoHtml(fx('ddg_results_redirect.html'));
    assert.ok(g.length === 2 && g.every((x) => x.url.startsWith('https://') && !x.url.includes('duckduckgo.com')));
  });
  test('DuckDuckGo bot check is detected (and never solved)', () => {
    assert.ok(search.isDuckDuckGoBlocked(202, fx('ddg_blocked.html')));
    assert.equal(search.isDuckDuckGoBlocked(200, fx('ddg_results.html')), undefined);
  });
  test('Bing ck/a links decode', () => {
    const r = search.parseBingHtml(fx('bing_results.html'));
    assert.equal(r.length, 3);
    assert.ok(r.every((x) => !x.url.includes('bing.com/ck')));
    assert.equal(search.isBingBlocked(200, fx('bing_results.html')), undefined);
  });
  test('SearXNG JSON', () => {
    const r = search.parseSearxngJson(JSON.parse(fx('searxng.json')));
    assert.equal(r[0].url, 'https://careers.cushmanwakefield.com/en/jobs/r343808/events-coordinator/');
  });
  test('a blocked backend is switched off for the run and the next one is used', async () => {
    const calls: string[] = [];
    const http = createResolverHttp({
      ...noWait,
      fetchImpl: stubFetch([
        { match: /html\.duckduckgo\.com/, status: 202, body: fx('ddg_blocked.html') },
        { match: /bing\.com\/search/, body: fx('bing_results.html') },
      ], calls),
    });
    const s = new search.Searcher(http, [search.duckduckgoBackend, search.bingBackend]);
    const first = await s.search('"Acme" "PR Executive"');
    assert.equal(first.backend, 'bing');
    assert.ok(s.blocked.has('duckduckgo'));
    await s.search('Acme careers jobs');
    assert.equal(calls.filter((c) => c.includes('duckduckgo')).length, 1, 'DDG asked once, then left alone');
  });
});

// ───────────────────────────── pages + agencies ─────────────────────────────

describe('pages and agency e-mails', () => {
  test('agency e-mail: only addresses written on the page, consultant preferred', () => {
    const info = page.analyzeHtml(fx('agency_job.html'), 'https://www.brightpathrecruitment.ie/jobs/digital-marketing-executive-4411');
    assert.ok(info.emails.includes('aoife.byrne@brightpathrecruitment.ie'));
    assert.ok(!info.emails.some((e) => e.startsWith('privacy@')));
    assert.equal(agency.pickAgencyEmail(info.emails, 'www.brightpathrecruitment.ie'), 'aoife.byrne@brightpathrecruitment.ie');
    assert.equal(agency.pickAgencyEmail([], 'www.x.ie'), undefined);
    assert.ok(agency.isAgency('Engage People Recruitment'));
    assert.ok(agency.isAgency('Robert Walters'));
    assert.equal(agency.isAgency('Ryanair'), false);
  });
  test('aggregator copies of a posting are never targets, even with matching JSON-LD', async () => {
    const { evaluatePage } = await import('../src/engine/resolve/resolver');
    const job = { id: 'x', company: "Ryanair - Europe's Favourite Airline", title: 'PR and Communications Executive', location: 'Swords, County Dublin, Ireland', url: '', applyUrl: '', ats: 'linkedin' as const, atsMeta: {}, source: 'linkedin_guest' as const, sourceId: 'x' };
    const copy = page.analyzeHtml(fx('company_posting.html'), 'https://jobera.com/job/ryanair-pr-and-communications-executive-1/');
    assert.equal(evaluatePage(job, copy, 'search', 'test', new Date()).target, undefined);
    const own = page.analyzeHtml(fx('company_posting.html'), 'https://careers.ryanair.com/jobs/pr-and-communications-executive/');
    const hit = evaluatePage(job, own, 'search', 'test', new Date());
    assert.equal(hit.target?.companyEvidence, 'jsonld_org');
    assert.match(hit.target?.applyUrl ?? '', /smartrecruiters\.com\/RyanairGroupHoldings\/744000151798952/, 'apply button to the ATS posting is preferred');
    const closed = page.analyzeHtml(fx('closed_posting.html'), 'https://careers.smythstoys.com/job/1');
    const cjob = { ...job, company: 'Smyths Toys Superstores', title: 'Marketing Executive', location: 'Galway, County Galway, Ireland' };
    assert.ok(evaluatePage(cjob, closed, 'search', 'test', new Date()).closed, 'a matching posting that closed is reported as closed');
  });

  test('JSON-LD JobPosting + closed notice', () => {
    const info = page.analyzeHtml(fx('company_posting.html'), 'https://careers.ryanair.com/jobs/pr-and-communications-executive/');
    assert.equal(info.jsonLd[0].title, 'PR and Communications Executive');
    assert.equal(info.jsonLd[0].hiringOrganization, 'Ryanair');
    assert.match(info.jsonLd[0].location ?? '', /Swords/);
    const closed = page.analyzeHtml(fx('closed_posting.html'), 'https://careers.smyths.ie/job/1');
    assert.ok(closed.closed);
  });
});

// ───────────────────────────── end to end on a temp DB ─────────────────────────────

function addJob(raw: Partial<RawJob> & { title: string; company: string; location: string }, status: 'scored' | 'ready' = 'ready'): string {
  const id = raw.sourceId ?? String(Math.floor(Math.random() * 1e9));
  const job = normalizeJob({
    source: 'linkedin_guest', sourceId: id, url: `https://www.linkedin.com/jobs/view/${id}`, atsMeta: { linkedinJobId: id }, ...raw,
  } as RawJob);
  dbm.upsertJob(job);
  dbm.setStatus(job.id, 'scored');
  if (status === 'ready') dbm.setStatus(job.id, 'ready');
  return job.id;
}

describe('resolveApplyTargets on a temp DB', () => {
  const routes: Route[] = [
    { match: /jobs-guest\/jobs\/api\/jobPosting\/4470314742/, body: fx('linkedin_offsite.html') },
    { match: /jobs-guest\/jobs\/api\/jobPosting\/4488887339/, body: fx('linkedin_easy_apply.html') },
    { match: /jobs-guest\/jobs\/api\/jobPosting\/5550000001/, body: fx('linkedin_offsite.html').replace(/PR and Communications Executive/g, 'Senior PR and Communications Executive') },
    { match: /api\.smartrecruiters\.com\/v1\/companies\/ryanairgroupholdings\/postings\?/, body: fx('smartrecruiters_ryanair.json') },
    { match: /api\.smartrecruiters\.com/, body: fx('smartrecruiters_missing.json') },
    { match: /html\.duckduckgo\.com/, body: '<html><body>no results</body></html>' },
  ];

  test('resolves Ryanair via SmartRecruiters, skips Easy-Apply-only, rejects the near miss', async () => {
    const ryanair = addJob({ sourceId: '4470314742', company: "Ryanair - Europe's Favourite Airline", title: 'PR and Communications Executive', location: 'Swords, County Dublin, Ireland' });
    const easy = addJob({ sourceId: '4488887339', company: 'Search Talent', title: 'Digital Marketing Executive', location: 'Dublin, County Dublin, Ireland' });
    const senior = addJob({ sourceId: '5550000001', company: 'Ryanair', title: 'Senior PR and Communications Executive', location: 'Dublin, Ireland' }, 'scored');

    const dryCalls: string[] = [];
    const dry = await resolveApplyTargets({ dryRun: true, limit: 10 }, {
      http: createResolverHttp({ ...noWait, fetchImpl: stubFetch(routes, dryCalls) }), crawler: null, watchlist: [], backends: [search.duckduckgoBackend],
    });
    assert.equal(dry.considered, 3);
    const byId = Object.fromEntries(dry.details.map((d) => [d.jobId, d]));
    assert.equal(byId[ryanair].result, 'resolved', JSON.stringify(byId[ryanair]));
    assert.equal(byId[ryanair].ats, 'smartrecruiters');
    assert.match(byId[ryanair].applyUrl ?? '', /jobs\.smartrecruiters\.com\/RyanairGroupHoldings\/744000151798952/);
    assert.equal(byId[easy].result, 'easy_apply_only');
    assert.equal(byId[senior].result, 'unresolved', 'Senior title must not match the non-senior posting');
    assert.equal(dbm.getJob(ryanair)?.ats, 'linkedin', 'dry run writes nothing');
    assert.ok(dryCalls.filter((c) => c.includes('linkedin.com')).every((c) => c.includes('/jobs-guest/')), 'LinkedIn: guest pages only');

    const live = await resolveApplyTargets({ limit: 10 }, {
      http: createResolverHttp({ ...noWait, fetchImpl: stubFetch(routes) }), crawler: null, watchlist: [], backends: [search.duckduckgoBackend],
    });
    assert.equal(live.resolved, 1);
    const r = dbm.getJob(ryanair)!;
    assert.equal(r.ats, 'smartrecruiters');
    assert.equal(r.status, 'ready', 'resolving never changes the status of a matched job');
    assert.equal(r.atsMeta.originalUrl, 'https://www.linkedin.com/jobs/view/4470314742');
    assert.equal(r.atsMeta.resolvedFrom, 'ats_probe');
    assert.equal(r.atsMeta.companyIdentifier, 'RyanairGroupHoldings', 'board identifiers are stored for the runner');
    assert.equal(r.atsMeta.postingId, '744000151798952');
    assert.ok(typeof r.atsMeta.resolvedAt === 'string' && typeof r.atsMeta.resolverConfidence === 'number');
    assert.equal(dbm.getJob(easy)?.status, 'skipped');
    const ev = dbm.listEvents({ jobId: easy, type: 'status' })[0];
    assert.equal((ev.detail?.detail as { reason?: string })?.reason, 'linkedin_easy_apply_only');
    const s = dbm.getJob(senior)!;
    assert.equal(s.status, 'scored', 'unresolved jobs keep their status (never needs_you)');
    assert.equal(s.atsMeta.resolveAttempts, 1);
    assert.ok(s.atsMeta.resolveFailedAt);

    // Retry rules: not again within 12 h; already-resolved jobs are never reconsidered.
    const again = selectJobs({}, new Date());
    assert.ok(!again.some((j) => j.id === senior || j.id === ryanair));
    const later = selectJobs({}, new Date(Date.now() + 13 * 3_600_000));
    assert.ok(later.some((j) => j.id === senior));
  });
});
