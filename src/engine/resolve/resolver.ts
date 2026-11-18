// Per-job resolution strategy: LinkedIn guest page → board slug probing (+ watchlist tokens) → web
// search → headless careers-page crawl. Stops at the first confident hit. Every candidate goes through
// match.judge(): company evidence AND title ≥ 0.75 AND location compatible (or unknown with strong evidence).

import type { Job, WatchCompany } from '@/lib/types';
import { isAgency, pickAgencyEmail } from './agency';
import { BoardProber, atsKindOf, classifyUrl, fetchSmartRecruitersPosting, isAtsKind, postingKey } from './ats';
import type { Crawler } from './crawl';
import { type ResolverHttp, hostOf } from './http';
import { type LinkedInApplyInfo, LinkedInClient, linkedInJobId } from './linkedin';
import {
  citiesIn, cleanTitle, companyDisplay, companyMatches, companySlugs, coreTokens, fold, hostMatchesCompany, judge, slugMatchesCompany,
  titleSimilarity, titleTokens,
} from './match';
import { type PageInfo, analyzeHtml, expiredByLd, pageTitles } from './page';
import type { Searcher, SearchResult } from './search';
import { PROBE_KINDS, type CompanyEvidence, type LinkedInApplyMode, type Posting, type ProbeKind, type ResolveMethod, type Target } from './types';
import { parseWorkdayUrl, searchWorkday, type WorkdayPosting } from './workday';

export type JobLike = Pick<Job, 'id' | 'company' | 'title' | 'location' | 'url' | 'applyUrl' | 'ats' | 'atsMeta' | 'source' | 'sourceId'>;

export interface ResolverDeps {
  http: ResolverHttp;
  prober: BoardProber;
  linkedin: LinkedInClient;
  searcher: Searcher;
  crawler?: Crawler;
  watchlist: WatchCompany[];
  now: () => Date;
  /** Headless crawl budget per job (default 25 s). */
  crawlBudgetMs?: number;
}

export interface JobResolution {
  outcome: 'resolved' | 'easy_apply_only' | 'closed' | 'unresolved' | 'deferred';
  target?: Target;
  linkedinMode: LinkedInApplyMode;
  reason: string;
  closedWhere?: 'linkedin' | 'employer';
  closedUrl?: string;
  trace: string[];
}

interface Check { target?: Target; closed?: { url: string; why: string }; rejected?: string; listing?: string }

/** SmartRecruiters company ids are often "{Name}GroupHoldings" (Ryanair), "{Name}Group", "{Name}DAC". */
const SR_ID_SUFFIXES = ['groupholdings', 'group', 'dac'];
const LISTING_TEXT = /\b(current (vacancies|openings|opportunities)|open (positions|roles)|search (all )?jobs|view (all )?(jobs|vacancies|roles|openings)|all jobs|job search|vacancies|see (all )?(open )?(jobs|roles|positions))\b/i;

// ───────────────────────────── Judging candidates ─────────────────────────────

function toTarget(job: JobLike, p: Posting, evidence: CompanyEvidence, method: ResolveMethod, via: string, v: ReturnType<typeof judge>): Target {
  return {
    applyUrl: p.applyUrl ?? p.url,
    postingUrl: p.url,
    kind: p.kind,
    ats: atsKindOf(p.kind),
    method,
    confidence: v.confidence,
    title: p.title,
    location: p.location,
    company: p.company,
    companyEvidence: evidence,
    locationVerdict: v.location,
    titleScore: v.titleScore,
    via,
    slug: p.slug,
    postingId: p.postingId,
  };
}

/** Best acceptable posting of a list; a matching-but-closed posting is reported as closed. */
function bestOf(
  job: JobLike, postings: Posting[], evidenceFor: (p: Posting) => CompanyEvidence | undefined,
  method: ResolveMethod, via: string, weak = false,
): Check {
  let best: Target | undefined;
  let closed: Check['closed'];
  let rejected: string | undefined;
  let rejectedScore = -1;
  for (const p of postings) {
    const evidence = evidenceFor(p);
    const v = judge(job, { title: p.title, location: p.location, remote: p.remote }, evidence, { weakSlug: weak && evidence === 'slug' });
    if (!v.ok) {
      if (v.titleScore > rejectedScore) {
        rejectedScore = v.titleScore;
        rejected = `${via}: ${v.reason}`;
      }
      continue;
    }
    if (p.closed) {
      closed ??= { url: p.url, why: 'posting no longer active' };
      continue;
    }
    const t = toTarget(job, p, evidence!, method, via, v);
    if (!best || t.confidence > best.confidence) best = t;
  }
  if (best) return { target: best };
  if (closed) return { closed };
  return rejected ? { rejected } : {};
}

function boardEvidence(job: JobLike, p: Posting, source: 'watchlist' | 'derived' | 'url'): CompanyEvidence | undefined {
  if (p.company) return companyMatches(p.company, job.company) ? 'api_name' : undefined;
  if (source === 'watchlist') return 'api_name';
  return p.slug && slugMatchesCompany(p.slug, job.company) ? 'slug' : undefined;
}

function workdayEvidence(job: JobLike, p: WorkdayPosting, tenant: string): CompanyEvidence | undefined {
  if (p.company && companyMatches(p.company, job.company)) return 'api_name';
  if (slugMatchesCompany(tenant, job.company)) return 'slug';
  if (p.description && mentionsCompany(p.description, job.company)) return 'page_text';
  return undefined;
}

function mentionsCompany(text: string, company: string): boolean {
  const name = fold(companyDisplay(company));
  const core = coreTokens(company).join(' ');
  const hay = ` ${fold(text.slice(0, 40_000))} `;
  return (name.length >= 3 && hay.includes(` ${name} `)) || (core.length >= 4 && hay.includes(` ${core} `));
}

/** Score of a link/card text against the job title, tolerant of trailing location/meta text. */
function linkScore(job: JobLike, text: string): number {
  if (!text || text.length > 300) return 0;
  const sim = titleSimilarity(job.title, text, job.company);
  if (!sim.seniorityMismatch && (sim.exact || sim.score >= 0.75)) return sim.score;
  const jobTokens = titleTokens(job.title, job.company);
  const linkTokens = titleTokens(text, job.company);
  if (jobTokens.length >= 2 && jobTokens.every((t, i) => linkTokens[i] === t)) {
    const rest = linkTokens.slice(jobTokens.length).filter((t) => !citiesIn(t).size && !/^(ireland|uk|remote|hybrid|full|time|part|permanent|contract|county|co|new|apply|now)$/.test(t));
    if (!rest.some((t) => ['senior', 'junior', 'lead', 'principal', 'head', 'director', 'manager', 'intern', 'graduate', 'trainee', 'chief'].includes(t)) && rest.length <= 2) return 0.8;
  }
  return 0;
}

function bestTitleLink(job: JobLike, info: PageInfo): string | undefined {
  let best: { href: string; s: number } | undefined;
  for (const l of info.links) {
    if (/^mailto:/i.test(l.href)) continue;
    const s = linkScore(job, l.text);
    if (s > 0 && (!best || s > best.s)) best = { href: l.href, s };
  }
  return best?.href;
}

/** Evaluates a posting page (HTTP-fetched or rendered). */
export function evaluatePage(job: JobLike, info: PageInfo, method: ResolveMethod, via: string, now: Date): Check {
  const host = hostOf(info.url);
  const cls = classifyUrl(info.url);
  if (['board', 'linkedin', 'indeed'].includes(cls.kind)) return {};
  let bestTitle = '';
  let bestScore = 0;
  for (const t of pageTitles(info)) {
    const sim = titleSimilarity(job.title, t, job.company);
    if (!sim.seniorityMismatch && sim.score > bestScore) {
      bestScore = sim.score;
      bestTitle = t;
    }
  }
  if (bestScore < 0.75) {
    const listing = bestTitleLink(job, info);
    return listing ? { listing } : { rejected: `${via}: page title does not match` };
  }
  const agency = isAgency(job.company);
  // Only the employer's own domain or a recognised ATS host can be the target. Aggregators copy the
  // posting (title, JSON-LD hiringOrganization and all), so page content alone proves nothing.
  const ownHost = hostMatchesCompany(host, job.company);
  if (!ownHost && !isAtsKind(cls.kind)) return { rejected: `${via}: third-party site (${host})` };
  const org = info.jsonLd.find((p) => p.hiringOrganization)?.hiringOrganization;
  let evidence: CompanyEvidence | undefined;
  if (ownHost) evidence = agency ? 'agency_site' : org && companyMatches(org, job.company) ? 'jsonld_org' : 'domain';
  else if (org && companyMatches(org, job.company)) evidence = 'jsonld_org';
  else if (info.ogSiteName && companyMatches(info.ogSiteName, job.company)) evidence = 'page_text';
  else if (mentionsCompany(`${info.title} ${info.text}`, job.company)) evidence = 'page_text';

  const ld = info.jsonLd.find((p) => p.location || p.remote);
  let location = ld?.location;
  if (!location) {
    const jobCities = citiesIn(job.location);
    const pageCities = citiesIn(info.text.slice(0, 30_000));
    const shared = [...jobCities].filter((c) => pageCities.has(c));
    if (shared.length) location = shared.join(', ');
  }
  const v = judge(job, { title: bestTitle, location, remote: ld?.remote }, evidence);
  if (!v.ok) return { rejected: `${via}: ${v.reason}` };
  const closedWhy = info.closed ?? expiredByLd(info, now);
  if (closedWhy) return { closed: { url: info.url, why: closedWhy } };

  // An "Apply" link or embedded form on a known ATS is the better applyUrl.
  const atsLink = [...info.iframes, ...info.links.filter((l) => /apply|application|submit/i.test(l.text) || /apply/i.test(l.href)).map((l) => l.href)]
    .find((href) => {
      const c = classifyUrl(href);
      if (!isAtsKind(c.kind)) return false;
      if (c.postingId) return true;
      if (c.kind === 'workday') return /\/job\//.test(href);
      return /(job|requisition|req|posting|vacanc)/i.test(href) && /\d{3,}/.test(href);
    });
  const kind = cls.kind !== 'unknown' ? cls.kind : agency ? 'agency' : 'company';
  const ids = classifyUrl(atsLink ?? info.url);
  const target: Target = {
    slug: ids.slug,
    postingId: ids.postingId,
    applyUrl: atsLink ?? info.url,
    postingUrl: info.url,
    kind: atsLink ? classifyUrl(atsLink).kind : kind,
    ats: atsKindOf(atsLink ? classifyUrl(atsLink).kind : cls.kind),
    method,
    confidence: v.confidence,
    title: bestTitle,
    location: location ?? '',
    company: org ?? info.ogSiteName,
    companyEvidence: evidence!,
    locationVerdict: v.location,
    titleScore: v.titleScore,
    via,
  };
  if (agency) {
    const email = pickAgencyEmail(info.emails, host);
    if (email) target.applyEmail = email;
  }
  return { target };
}

// ───────────────────────────── Resolver ─────────────────────────────

export class Resolver {
  constructor(private readonly deps: ResolverDeps) {}

  /** Board probe for (kind, slug), judged against the job. */
  private async probe(job: JobLike, kind: ProbeKind, slug: string, source: 'watchlist' | 'derived' | 'url', weak: boolean, postingId?: string): Promise<Check> {
    const r = await this.deps.prober.probe(kind, slug, job.title);
    if (!r.exists || !r.postings.length) return {};
    let postings = r.postings;
    if (postingId) {
      const exact = postings.filter((p) => p.postingId?.toLowerCase() === postingId.toLowerCase());
      if (exact.length) postings = exact;
    }
    const method: ResolveMethod = source === 'watchlist' ? 'watchlist' : source === 'url' ? 'search' : 'ats_probe';
    return bestOf(job, postings, (p) => boardEvidence(job, p, source), method, `${kind}:${slug}`, weak);
  }

  async probeStage(job: JobLike, li?: LinkedInApplyInfo): Promise<Check> {
    const tasks: Promise<Check>[] = [];
    for (const w of this.deps.watchlist) {
      if (w.enabled && companyMatches(w.name, job.company)) tasks.push(this.probe(job, w.ats, w.token, 'watchlist', false));
    }
    const slugs = companySlugs(job.company, li?.companySlug ? [li.companySlug] : []);
    for (const kind of PROBE_KINDS) {
      // Workable rate-limits hard and SmartRecruiters gets extra suffix ids: fewer plain slugs for both.
      const list = kind === 'workable' || kind === 'smartrecruiters' ? slugs.slice(0, 3) : slugs;
      for (const s of list) tasks.push(this.probe(job, kind, s.slug, 'derived', s.weak));
    }
    const core = coreTokens(job.company).join('');
    if (core.length >= 3) for (const suffix of SR_ID_SUFFIXES) tasks.push(this.probe(job, 'smartrecruiters', `${core}${suffix}`, 'derived', false));
    const checks = await Promise.all(tasks);
    const targets = checks.map((c) => c.target).filter((t): t is Target => Boolean(t)).sort((a, b) => b.confidence - a.confidence);
    if (targets.length) return { target: targets[0] };
    const closed = checks.find((c) => c.closed);
    if (closed) return closed;
    return {};
  }

  /** Verifies any candidate URL: board APIs where we can, else the page itself (rendered if needed). */
  async verifyUrl(job: JobLike, url: string, method: ResolveMethod, via: string, deadline: number, depth = 0): Promise<Check> {
    const c = classifyUrl(url);
    if (['board', 'linkedin', 'indeed'].includes(c.kind)) return {};
    if (c.kind === 'workday') {
      const site = parseWorkdayUrl(url);
      if (!site) return {};
      const postings = await searchWorkday(this.deps.http, site, job.title, job.company);
      return bestOf(job, postings, (p) => workdayEvidence(job, p as WorkdayPosting, site.tenant), method, via);
    }
    if (c.kind === 'smartrecruiters' && c.slug && c.postingId) {
      const p = await fetchSmartRecruitersPosting(this.deps.http, c.slug, c.postingId);
      if (p) return bestOf(job, [p], (x) => boardEvidence(job, x, 'url'), method, via);
    }
    if (c.slug && (PROBE_KINDS as readonly string[]).includes(c.kind)) {
      const check = await this.probe(job, c.kind as ProbeKind, c.slug, 'url', false, c.postingId);
      if (check.target || check.closed) return { ...check, target: check.target ? { ...check.target, method, via } : undefined };
      if (check.rejected) return check;
    }
    return this.verifyPage(job, url, method, via, deadline, depth);
  }

  async verifyPage(job: JobLike, url: string, method: ResolveMethod, via: string, deadline: number, depth = 0): Promise<Check> {
    const res = await this.deps.http.get(url);
    let info: PageInfo | undefined;
    if (res.status === 200 && res.text) {
      info = analyzeHtml(res.text, res.url, res.status);
      if (info.botWall) {
        this.deps.http.park(hostOf(res.url), `bot check: ${info.botWall}`);
        return { rejected: `${via}: bot check (left alone)` };
      }
    }
    let check = info ? evaluatePage(job, info, method, via, this.deps.now()) : {};
    const shell = !info || (info.text.length < 600 && info.links.length < 15);
    if (!check.target && !check.closed && shell && this.deps.crawler && Date.now() < deadline - 5_000) {
      const rendered = await this.deps.crawler.open(url, deadline);
      if (rendered && !rendered.botWall) check = evaluatePage(job, rendered, method, via, this.deps.now());
    }
    // A verified page whose apply button points at a known ATS posting: prefer the API-verified ATS target.
    if (check.target && depth === 0 && check.target.applyUrl !== check.target.postingUrl && classifyUrl(check.target.applyUrl).postingId) {
      const ats = await this.verifyUrl(job, check.target.applyUrl, method, `${via} → apply link`, deadline, 1);
      if (ats.target) return { target: { ...ats.target, applyEmail: check.target.applyEmail } };
    }
    return check;
  }

  rank(job: JobLike, results: SearchResult[]): { url: string; role: 'posting' | 'careers'; score: number }[] {
    const out: { url: string; role: 'posting' | 'careers'; score: number }[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const c = classifyUrl(r.url);
      if (['board', 'linkedin', 'indeed'].includes(c.kind)) continue;
      const key = postingKey(r.url);
      if (seen.has(key)) continue;
      const host = hostOf(r.url);
      const titleSim = Math.max(titleSimilarity(job.title, r.title, job.company).score, linkScore(job, r.title));
      let entry: { url: string; role: 'posting' | 'careers'; score: number } | undefined;
      if (c.kind === 'workday') entry = { url: r.url, role: 'posting', score: 90 };
      else if (isAtsKind(c.kind)) {
        if (c.slug && slugMatchesCompany(c.slug, job.company)) entry = { url: r.url, role: 'posting', score: c.postingId ? 100 : 85 };
        else if (titleSim >= 0.75) entry = { url: r.url, role: 'posting', score: 70 };
      } else if (hostMatchesCompany(host, job.company)) {
        const path = (() => { try { return new URL(r.url).pathname.toLowerCase(); } catch { return ''; } })();
        if (titleSim >= 0.5) entry = { url: r.url, role: 'posting', score: 80 };
        else if (/career|job|vacanc|join|work-with-us|opportunit|recruit/.test(path) || /career|jobs|vacanc/i.test(r.title)) entry = { url: r.url, role: 'careers', score: 50 };
      }
      // Anything else (aggregators, news, directories) is never a target, however well it matches.
      if (entry) {
        seen.add(key);
        out.push(entry);
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  async searchStage(job: JobLike, mode: LinkedInApplyMode, deadline: number, trace: string[]): Promise<{ check?: Check; careers: string[]; searched: boolean }> {
    const careers: string[] = [];
    if (!this.deps.searcher.available()) return { careers, searched: false };
    const company = companyDisplay(job.company);
    const title = cleanTitle(job.title, job.company);
    const queries = [`"${company}" "${title}"`];
    if (mode !== 'easy_apply') queries.push(`${company} careers jobs`);
    let searched = false;
    const method: ResolveMethod = isAgency(job.company) ? 'agency' : 'search';
    for (const q of queries) {
      const out = await this.deps.searcher.search(q);
      if (out.unavailable) {
        trace.push(`search unavailable (${q})`);
        break;
      }
      searched = true;
      const ranked = this.rank(job, out.results);
      trace.push(`search[${out.backend}] ${out.results.length} results, ${ranked.length} candidates: ${q}`);
      let verified = 0;
      for (const r of ranked) {
        if (r.role === 'careers') {
          if (!careers.includes(r.url)) careers.push(r.url);
          continue;
        }
        if (verified >= 4) break;
        verified++;
        const check = await this.verifyUrl(job, r.url, method, `search: ${r.url}`, deadline);
        if (check.target || check.closed) return { check, careers, searched };
        if (check.listing && !careers.includes(check.listing)) careers.unshift(check.listing);
        if (check.rejected) trace.push(`rejected ${check.rejected}`);
      }
    }
    return { careers, searched };
  }

  async crawlStage(job: JobLike, careers: string[], deadline: number, trace: string[]): Promise<Check> {
    const crawler = this.deps.crawler;
    if (!crawler) return {};
    const method: ResolveMethod = isAgency(job.company) ? 'agency' : 'crawl';
    for (const start of careers.slice(0, 2)) {
      if (Date.now() > deadline - 4_000) break;
      const page = await crawler.open(start, deadline);
      if (!page || page.botWall) {
        trace.push(`crawl ${start}: ${page?.botWall ? 'bot check, stopped' : 'no page'}`);
        continue;
      }
      let check = evaluatePage(job, page, method, `crawl: ${page.url}`, this.deps.now());
      if (check.target || check.closed) return check;
      let link = check.listing ?? bestTitleLink(job, page);
      let hops = 1;
      if (!link) {
        // Embedded or linked ATS board on the careers page: probe it by API.
        for (const src of [...page.iframes, ...page.links.map((l) => l.href)]) {
          const c = classifyUrl(src);
          if (c.kind === 'workday' || (c.slug && (PROBE_KINDS as readonly string[]).includes(c.kind))) {
            const v = await this.verifyUrl(job, src, method, `crawl: ${start} → ${c.kind}`, deadline, 1);
            if (v.target || v.closed) return v;
            break;
          }
        }
        const listing = page.links.find((l) => LISTING_TEXT.test(l.text) && hostOf(l.href) === hostOf(page.url));
        if (listing && Date.now() < deadline - 4_000) {
          const p2 = await crawler.open(listing.href, deadline);
          hops = 2;
          if (p2 && !p2.botWall) {
            check = evaluatePage(job, p2, method, `crawl: ${p2.url}`, this.deps.now());
            if (check.target || check.closed) return check;
            link = check.listing ?? bestTitleLink(job, p2);
          }
        }
      }
      if (!link || hops > 2 || Date.now() > deadline - 3_000) {
        trace.push(`crawl ${start}: no matching link`);
        continue;
      }
      const c = classifyUrl(link);
      if (isAtsKind(c.kind)) {
        const v = await this.verifyUrl(job, link, method, `crawl: ${link}`, deadline, 1);
        if (v.target || v.closed) return v;
      }
      const posting = await crawler.open(link, deadline);
      if (posting && !posting.botWall) {
        check = evaluatePage(job, posting, method, `crawl: ${posting.url}`, this.deps.now());
        if (check.target || check.closed) return check;
        if (check.rejected) trace.push(`rejected ${check.rejected}`);
      }
    }
    return {};
  }

  async resolve(job: JobLike): Promise<JobResolution> {
    const trace: string[] = [];
    const deadline = Date.now() + (this.deps.crawlBudgetMs ?? 25_000) + 60_000;
    const crawlDeadline = () => Math.min(deadline, Date.now() + (this.deps.crawlBudgetMs ?? 25_000));
    let li: LinkedInApplyInfo | undefined;
    let liProblem: string | undefined;
    const liId = linkedInJobId(job);

    // 1. LinkedIn guest page.
    if (liId) {
      const r = await this.deps.linkedin.fetch(liId);
      if (r.info) li = r.info;
      liProblem = r.blocked ?? r.error;
      trace.push(`linkedin ${liId}: ${li ? li.mode : `failed (${liProblem})`}`);
      if (li?.closed) return { outcome: 'closed', linkedinMode: li.mode, reason: 'LinkedIn: no longer accepting applications', closedWhere: 'linkedin', closedUrl: job.url, trace };
    }
    const mode: LinkedInApplyMode = li?.mode ?? 'unknown';
    const done = (check: Check, stage: string): JobResolution | undefined => {
      if (check.target) return { outcome: 'resolved', target: check.target, linkedinMode: mode, reason: check.target.via ?? stage, trace };
      if (check.closed) return { outcome: 'closed', linkedinMode: mode, reason: `${stage}: ${check.closed.why}`, closedWhere: 'employer', closedUrl: check.closed.url, trace };
      return undefined;
    };

    // 0. The current apply URL may already be an employer page (gmail alerts, manual adds).
    const current = classifyUrl(job.applyUrl);
    if (!['board', 'linkedin', 'indeed'].includes(current.kind) && job.applyUrl !== job.url) {
      const hit = done(await this.verifyUrl(job, job.applyUrl, 'direct', `current: ${job.applyUrl}`, crawlDeadline()), 'direct');
      if (hit) return hit;
    }

    // 1b. Links written in the LinkedIn description.
    for (const link of (li?.links ?? []).slice(0, 4)) {
      const hit = done(await this.verifyUrl(job, link, 'linkedin_description', `linkedin description: ${link}`, crawlDeadline()), 'linkedin description');
      if (hit) return hit;
    }

    // 2. Board slug probing (+ verified watchlist tokens).
    const probed = done(await this.probeStage(job, li), 'ats probe');
    if (probed) return probed;
    trace.push('ats probe: no match');

    // 3. Web search, 4. careers-page crawl (agencies go through the same path, judged as agency sites).
    const s = await this.searchStage(job, mode, crawlDeadline(), trace);
    if (s.check) {
      const hit = done(s.check, s.check.target?.method ?? 'search');
      if (hit) return hit;
    }
    let crawlCut = false;
    if (s.careers.length && this.deps.crawler) {
      const cd = crawlDeadline();
      const hit = done(await this.crawlStage(job, s.careers, cd, trace), 'crawl');
      if (hit) return hit;
      crawlCut = Date.now() >= cd - 4_000;
    }

    if (!s.searched) return { outcome: 'deferred', linkedinMode: mode, reason: 'search unavailable this run', trace };
    // Only skip as Easy-Apply-only when every stage finished: a crawl cut short by its time budget proves nothing.
    if (mode === 'easy_apply' && crawlCut) return { outcome: 'deferred', linkedinMode: mode, reason: 'careers crawl ran out of time', trace };
    if (mode === 'easy_apply') return { outcome: 'easy_apply_only', linkedinMode: mode, reason: 'LinkedIn Easy Apply; no employer posting found', trace };
    if (liId && !li) return { outcome: 'deferred', linkedinMode: mode, reason: `LinkedIn page unavailable (${liProblem})`, trace };
    return { outcome: 'unresolved', linkedinMode: mode, reason: 'no confident employer posting found', trace };
  }
}

export { postingKey };
