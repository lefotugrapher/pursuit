// Board search (Workable + SmartRecruiters public job search): mapping, Ireland filter, paging, dedupe,
// and the Workable filler's jobs.workable.com dialog selectors. No network: a stub Http serves canned JSON.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';

const bs = await import('../src/engine/sources/boardSearch');
const norm = await import('../src/engine/sources/normalize');
const { adapter: workableFiller } = await import('../src/engine/apply/workable');

type Http = import('../src/lib/types').Http;
type SourcesConfig = import('../src/lib/types').SourcesConfig;
type SourceContext = import('../src/lib/types').SourceContext;
type Profile = import('../src/lib/types').Profile;

class StubHttp implements Http {
  readonly calls: string[] = [];
  constructor(private readonly route: (url: string) => unknown) {}
  async get(url: string) {
    this.calls.push(url);
    const body = this.route(url);
    if (body instanceof Error) return { status: 500, text: body.message, url };
    return { status: 200, text: JSON.stringify(body), url };
  }
  async json<T>(url: string): Promise<T> {
    const res = await this.get(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.text) as T;
  }
}

const silent = { info() {}, warn() {}, error() {} };
function ctx(http: Http, queries: string[] = ['marketing executive']): SourceContext {
  const sources: SourcesConfig = {
    companies: [],
    linkedinGuest: { enabled: true, queries: queries.map((k) => ({ keywords: k, location: 'Ireland' })), maxPerQuery: 25, minIntervalMs: 3000 },
    adzuna: { enabled: false, queries: [] },
    gmailAlerts: { enabled: true },
    boardSearch: { enabled: true, queries: [] },
    titleMustMatch: ['marketing', 'communication', 'event'],
  };
  return { sources, profile: {} as Profile, http, log: silent };
}

const wk = (over: Record<string, unknown> = {}) => ({
  id: 'w-1', title: 'Marketing Executive', state: 'published', description: '<p>Do marketing.</p>', requirementsSection: '<p>2 years.</p>',
  employmentType: 'Full time', url: 'https://jobs.workable.com/view/abc/marketing-executive', locations: ['Dublin, County Dublin, Ireland'],
  location: { city: 'Dublin', subregion: 'County Dublin', countryName: 'Ireland' }, created: '2026-11-15T10:00:00.000Z',
  company: { id: 'c-1', title: 'Acme Ltd', website: 'https://acme.ie' }, workplace: 'on_site', linkoutUrl: null, ...over,
});

const sr = (over: Record<string, unknown> = {}) => ({
  id: '744000111', name: 'Events Coordinator', releasedDate: '2026-11-15T10:00:00.000Z',
  location: { city: 'Dublin', region: '', country: 'ie', remote: false },
  company: { identifier: 'BigCo', name: 'BigCo' },
  actions: { details: 'https://api.smartrecruiters.com/v1/companies/BigCo/postings/111' },
  applyUrl: 'https://jobs.smartrecruiters.com/BigCo/744000111-events-coordinator', ...over,
});

describe('boardQueries', () => {
  test('falls back to the LinkedIn keywords, lowercased and deduped', () => {
    const c = ctx(new StubHttp(() => ({})), ['Marketing Executive', 'marketing  executive', 'PR executive']);
    assert.deepEqual(bs.boardQueries(c), ['marketing executive', 'pr executive']);
  });
  test('own queries win', () => {
    const c = ctx(new StubHttp(() => ({})));
    c.sources.boardSearch.queries = ['events'];
    assert.deepEqual(bs.boardQueries(c), ['events']);
  });
});

describe('Workable search', () => {
  test('maps a result onto the jobs.workable.com page, which Pursuit fills as Workable', () => {
    const raw = bs.mapWorkableSearchJob(wk());
    assert.ok(raw);
    assert.equal(raw.source, 'workable');
    assert.equal(raw.company, 'Acme Ltd');
    assert.equal(raw.location, 'Dublin, County Dublin, Ireland');
    assert.equal(raw.applyUrl, 'https://jobs.workable.com/view/abc/marketing-executive');
    assert.match(raw.descriptionHtml ?? '', /Do marketing[\s\S]*2 years/);
    assert.equal(norm.detectAts(raw.applyUrl), 'workable');
  });

  test('a linkout sends the application to the employer URL instead', () => {
    const raw = bs.mapWorkableSearchJob(wk({ linkoutUrl: 'https://boards.greenhouse.io/acme/jobs/1' }));
    assert.equal(raw?.applyUrl, 'https://boards.greenhouse.io/acme/jobs/1');
    assert.equal(raw?.atsMeta?.ats, undefined);
  });

  test('remote via TELECOMMUTE; unpublished and incomplete rows dropped', () => {
    assert.equal(bs.mapWorkableSearchJob(wk({ locations: ['TELECOMMUTE', 'Ireland'] }))?.remote, true);
    assert.equal(bs.mapWorkableSearchJob(wk({ state: 'closed' })), null);
    assert.equal(bs.mapWorkableSearchJob(wk({ company: {} })), null);
  });

  test('follows nextPageToken, keeps Ireland only, applies the title filter', async () => {
    const http = new StubHttp((url) => {
      if (!url.includes('pageToken')) return { jobs: [wk(), wk({ id: 'w-2', title: 'Warehouse Operative' })], nextPageToken: 'T2' };
      return { jobs: [wk({ id: 'w-3', location: { city: 'London', countryName: 'United Kingdom' } }), wk({ id: 'w-4', title: 'Events Manager' })], nextPageToken: null };
    });
    const out = await bs.searchWorkable(ctx(http), 'marketing');
    assert.deepEqual(out.map((r) => r.sourceId), ['w-1', 'w-4']);
    assert.equal(http.calls.length, 2);
    assert.match(http.calls[0], /query=marketing&location=Ireland$/);
    assert.match(http.calls[1], /pageToken=T2/);
  });
});

describe('SmartRecruiters search', () => {
  test('puts ireland in the keyword, keeps Irish postings, fetches detail once', async () => {
    const http = new StubHttp((url) => {
      if (url.includes('sr-jobs/search')) return { content: [sr(), sr({ id: '744000222', location: { city: 'Paris', country: 'fr' } }), sr({ id: '744000333', name: 'Forklift Driver' })] };
      if (url.includes('/postings/111')) return { id: '744000111', postingUrl: 'https://jobs.smartrecruiters.com/BigCo/744000111', applyUrl: 'https://jobs.smartrecruiters.com/BigCo/744000111?apply', jobAd: { sections: { jobDescription: { title: 'Job', text: 'Run events.' } } } };
      return new Error('unexpected');
    });
    const out = await bs.searchSmartRecruiters(ctx(http), 'events', { left: 5 });
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'smartrecruiters');
    assert.equal(out[0].sourceId, '744000111');
    assert.equal(out[0].company, 'BigCo');
    assert.match(out[0].descriptionHtml ?? '', /Run events/);
    assert.match(http.calls[0], /keyword=events%20ireland/);
  });

  test('without detail budget, the public posting URL is used', async () => {
    const http = new StubHttp(() => ({ content: [sr()] }));
    const out = await bs.searchSmartRecruiters(ctx(http), 'events', { left: 0 });
    assert.equal(out[0].applyUrl, 'https://jobs.smartrecruiters.com/BigCo/744000111-events-coordinator');
    assert.equal(http.calls.length, 1);
  });
});

describe('fetchBoardSearch', () => {
  test('dedupes across queries and survives one site failing', async () => {
    const http = new StubHttp((url) => (url.includes('workable') ? { jobs: [wk()], nextPageToken: null } : new Error('blocked')));
    const out = await bs.fetchBoardSearch(ctx(http, ['marketing executive', 'marketing assistant']));
    assert.deepEqual(out.map((r) => `${r.source}:${r.sourceId}`), ['workable:w-1']);
  });

  test('throws when every search fails, so the run shows the source as broken', async () => {
    const http = new StubHttp(() => new Error('down'));
    await assert.rejects(bs.fetchBoardSearch(ctx(http)), /every board search failed/);
  });
});

describe('Workable filler on jobs.workable.com', () => {
  test('dialog submit is targeted, Cancel never is', () => {
    assert.ok(workableFiller.submitSelectors.includes('button[data-ui="application-form-submit"]'));
    for (const s of workableFiller.submitSelectors) {
      if (s.includes('button[type="submit"]')) assert.match(s, /:not\(\[data-ui="application-form-cancel"\]\)/);
    }
  });
});
