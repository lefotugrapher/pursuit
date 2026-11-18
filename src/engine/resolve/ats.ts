// Employer boards: classify any URL (which ATS / board / site is it?), and probe public board APIs by
// company slug: Greenhouse, Lever (+EU), Ashby, SmartRecruiters, Workable, Teamtailor, Personio,
// Recruitee, BambooHR. Parsers are pure and fixture-tested; probing is cached per run.

import type { AtsKind } from '@/lib/types';
import { cleanInline, decodeEntities } from '@/engine/sources/normalize';
import { type FetchResult, type ResolverHttp, hostOf, jsonOf } from './http';
import { cleanTitle } from './match';
import type { Posting, ProbeKind, SiteKind } from './types';

// ───────────────────────────── URL classification ─────────────────────────────

export interface UrlClass { kind: SiteKind; slug?: string; postingId?: string }

/** Job boards / aggregators / social sites: never an employer target. */
const BOARD_HOSTS = [
  'linkedin.com', 'lnkd.in', 'glassdoor.com', 'glassdoor.ie', 'glassdoor.co.uk', 'irishjobs.ie', 'jobs.ie', 'ziprecruiter.ie',
  'ziprecruiter.com', 'ziprecruiter.co.uk', 'jooble.org', 'talent.com', 'trabajo.org', 'jobijoba.ie', 'jobijoba.com', 'expertini.com',
  'builtin.com', 'role.com', 'broxer.com', 'refresh.cv', 'irishtalents.com', 'monster.ie', 'monster.com', 'monster.co.uk',
  'totaljobs.com', 'reed.co.uk', 'simplyhired.com', 'simplyhired.ie', 'careerjet.ie', 'careerjet.com', 'adzuna.ie', 'adzuna.co.uk',
  'adzuna.com', 'whatjobs.com', 'jobrapido.com', 'recruit.net', 'jobted.ie', 'jobted.com', 'neuvoo.com', 'gradireland.com',
  'publicjobs.ie', 'nijobs.com', 'jobsireland.ie', 'recruitireland.com', 'jobbio.com', 'jobgether.com', 'joblet.ai', 'otta.com',
  'welcometothejungle.com', 'wellfound.com', 'angel.co', 'workinstartups.com', 'remoteok.com', 'weworkremotely.com',
  'himalayas.app', 'remotive.com', 'jobleads.com', 'jobtome.com', 'lensa.com', 'jobsora.com', 'jobilize.com', 'efinancialcareers.com',
  'efinancialcareers.ie', 'hosco.com', 'caterer.com', 'gumtree.com', 'donedeal.ie', 'facebook.com', 'instagram.com', 'twitter.com',
  'x.com', 'youtube.com', 'wikipedia.org', 'reddit.com', 'quora.com', 'crunchbase.com', 'zoominfo.com', 'rocketreach.co',
  'bloomberg.com', 'companieshouse.gov.uk', 'solocheck.ie', 'vision-net.ie', 'cv-library.co.uk', 'jobserve.com', 'indeed.jobs',
  'jobisjob.ie', 'learn4good.com', 'jobsinireland.ie', 'irishjobsearch.ie', 'workday.com', 'myworkday.com', 'tiktok.com',
  'pinterest.com', 'apple.com', 'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'jobs.smartrecruiters.com/search',
];

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isBoardHost(host: string): boolean {
  const h = host.toLowerCase();
  if (/(^|\.)indeed\.[a-z.]+$/.test(h)) return true;
  if (/(^|\.)glassdoor\.[a-z.]+$/.test(h)) return true;
  return BOARD_HOSTS.some((d) => !d.includes('/') && hostIs(h, d));
}

/** Which ATS / site a URL is, with the board slug and posting id when the URL carries them. */
export function classifyUrl(raw: string): UrlClass {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'unknown' };
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const ghJid = u.searchParams.get('gh_jid');

  if (hostIs(host, 'linkedin.com') || host === 'lnkd.in') return { kind: 'linkedin' };
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return { kind: 'indeed' };
  if (hostIs(host, 'greenhouse.io')) {
    if (seg[0] === 'embed') return { kind: 'greenhouse', slug: u.searchParams.get('for') ?? undefined, postingId: u.searchParams.get('token') ?? undefined };
    if (host.startsWith('boards-api')) return { kind: 'greenhouse', slug: seg[2], postingId: seg[4] };
    return { kind: 'greenhouse', slug: seg[0], postingId: seg[1] === 'jobs' ? seg[2] : ghJid ?? undefined };
  }
  if (ghJid && /^\d+$/.test(ghJid)) return { kind: 'greenhouse', postingId: ghJid };
  if (hostIs(host, 'lever.co')) {
    if (host.startsWith('api')) return { kind: 'lever', slug: seg[2], postingId: seg[3] };
    return { kind: 'lever', slug: seg[0], postingId: seg[1] && /^[0-9a-f-]{20,}$/i.test(seg[1]) ? seg[1] : undefined };
  }
  if (hostIs(host, 'ashbyhq.com')) {
    if (host.startsWith('api')) return { kind: 'ashby', slug: seg[2] };
    return { kind: 'ashby', slug: seg[0], postingId: seg[1] && /^[0-9a-f-]{20,}$/i.test(seg[1]) ? seg[1] : undefined };
  }
  if (hostIs(host, 'smartrecruiters.com')) {
    if (host.startsWith('api')) return { kind: 'smartrecruiters', slug: seg[2], postingId: seg[4] };
    if (seg[0] === 'oneclick-ui') return { kind: 'smartrecruiters', slug: seg[2], postingId: undefined };
    const id = /^(\d{6,})/.exec(seg[1] ?? '')?.[1];
    return { kind: 'smartrecruiters', slug: seg[0], postingId: id };
  }
  if (hostIs(host, 'workable.com')) {
    if (host === 'apply.workable.com') {
      if (seg[0] === 'api') return { kind: 'workable', slug: seg[4] };
      if (seg[0] === 'j') return { kind: 'workable', postingId: seg[1] };
      return { kind: 'workable', slug: seg[0], postingId: seg[1] === 'j' ? seg[2] : undefined };
    }
    const sub = host.split('.')[0];
    return { kind: 'workable', slug: sub === 'www' ? undefined : sub, postingId: seg[0] === 'j' ? seg[1] : undefined };
  }
  if (hostIs(host, 'myworkdayjobs.com') || hostIs(host, 'myworkdaysite.com')) return { kind: 'workday' };
  if (hostIs(host, 'teamtailor.com')) {
    const sub = host.split('.')[0];
    const id = seg[0] === 'jobs' ? /^(\d+)/.exec(seg[1] ?? '')?.[1] : undefined;
    return { kind: 'teamtailor', slug: sub === 'www' || sub === 'app' ? undefined : sub, postingId: id };
  }
  if (hostIs(host, 'jobs.personio.de') || hostIs(host, 'jobs.personio.com')) {
    return { kind: 'personio', slug: host.split('.')[0], postingId: seg[0] === 'job' ? seg[1] : undefined };
  }
  if (hostIs(host, 'recruitee.com')) return { kind: 'recruitee', slug: host.split('.')[0], postingId: seg[0] === 'o' ? seg[1] : undefined };
  if (hostIs(host, 'bamboohr.com')) {
    const sub = host.split('.')[0];
    const id = seg[0] === 'careers' && /^\d+$/.test(seg[1] ?? '') ? seg[1] : seg[0] === 'jobs' ? u.searchParams.get('id') ?? undefined : undefined;
    return { kind: 'bamboohr', slug: sub === 'www' ? undefined : sub, postingId: id };
  }
  if (hostIs(host, 'icims.com')) return { kind: 'icims' };
  if (hostIs(host, 'taleo.net')) return { kind: 'taleo' };
  if (hostIs(host, 'successfactors.com') || hostIs(host, 'successfactors.eu') || hostIs(host, 'sapsf.com') || hostIs(host, 'sapsf.eu')) return { kind: 'successfactors' };
  if (hostIs(host, 'jobvite.com')) return { kind: 'jobvite', slug: seg[0] };
  if (hostIs(host, 'pinpointhq.com')) return { kind: 'pinpoint', slug: host.split('.')[0] };
  if (hostIs(host, 'breezy.hr')) return { kind: 'breezy', slug: host.split('.')[0] };
  if (hostIs(host, 'rippling.com') && seg[0]) return { kind: 'rippling', slug: seg[0] };
  if (hostIs(host, 'applytojob.com')) return { kind: 'jazzhr', slug: host.split('.')[0] };
  if (hostIs(host, 'zohorecruit.com') || hostIs(host, 'zohorecruit.eu')) return { kind: 'zoho' };
  if (hostIs(host, 'avature.net')) return { kind: 'avature' };
  if (hostIs(host, 'hirehive.com')) return { kind: 'hirehive', slug: host.split('.')[0] };
  if (isBoardHost(host)) return { kind: 'board' };
  return { kind: 'unknown' };
}

/** Kinds the job row can store directly as `ats`; the rest are stored as 'unknown' + atsMeta.resolvedAts. */
export function atsKindOf(kind: SiteKind): AtsKind {
  switch (kind) {
    case 'greenhouse': case 'lever': case 'ashby': case 'smartrecruiters': case 'workable': case 'workday': case 'linkedin': case 'indeed':
      return kind;
    default:
      return 'unknown';
  }
}

/** Hosts of every ATS we recognise (search ranking + "apply" link detection). */
export function isAtsKind(kind: SiteKind): boolean {
  return !['company', 'agency', 'linkedin', 'indeed', 'board', 'unknown'].includes(kind);
}

/** Stable identity of a posting for duplicate detection ("lever:websummit:396e…", else the bare URL). */
export function postingKey(url: string): string {
  const c = classifyUrl(url);
  if (c.slug && c.postingId) return `${c.kind}:${c.slug.toLowerCase()}:${c.postingId.toLowerCase()}`;
  if (c.kind === 'greenhouse' && c.postingId) return `greenhouse:*:${c.postingId}`;
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/\/+$/, '').replace(/\/(apply|application|login)$/i, '');
    if (c.kind === 'workday') p = p.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '').replace(/^\/recruiting/, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${p.toLowerCase()}`;
  } catch {
    return url;
  }
}

// ───────────────────────────── Parsers ─────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? cleanInline(v) : typeof v === 'number' ? String(v) : undefined);
const join = (parts: (string | undefined | null)[], sep = ', ') => [...new Set(parts.map((p) => cleanInline(p ?? '')).filter(Boolean))].join(sep);
const COUNTRY_CODES: Record<string, string> = { IE: 'Ireland', GB: 'United Kingdom', UK: 'United Kingdom', US: 'United States', NL: 'Netherlands', DE: 'Germany', FR: 'France', ES: 'Spain', PT: 'Portugal' };

interface GhJob { id?: number; title?: string; absolute_url?: string; company_name?: string; location?: { name?: string } | null; offices?: { name?: string; location?: string | null }[] }

export function parseGreenhouseJobs(data: unknown, slug: string): Posting[] {
  const jobs = (data as { jobs?: GhJob[] })?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((j) => {
    const title = str(j.title);
    if (!title || j.id === undefined) return [];
    const hosted = `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${j.id}`;
    const abs = str(j.absolute_url);
    const location = join([j.location?.name, ...(j.offices ?? []).map((o) => o.location || o.name)], ' / ');
    const p: Posting = { kind: 'greenhouse', slug, postingId: String(j.id), title, location, url: abs ?? hosted, applyUrl: hosted };
    const company = str(j.company_name);
    if (company) p.company = company;
    return [p];
  });
}

interface LeverPosting { id?: string; text?: string; hostedUrl?: string; applyUrl?: string; country?: string; workplaceType?: string; categories?: { location?: string; allLocations?: string[] } }

export function parseLeverPostings(data: unknown, slug: string): Posting[] {
  if (!Array.isArray(data)) return [];
  return (data as LeverPosting[]).flatMap((p) => {
    const title = str(p.text);
    if (!title || !p.id || !p.hostedUrl) return [];
    const locs = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location];
    const country = p.country ? COUNTRY_CODES[p.country.toUpperCase()] ?? p.country : undefined;
    const out: Posting = {
      kind: 'lever', slug, postingId: p.id, title,
      location: join([join(locs, ' / '), country]),
      url: p.hostedUrl,
      applyUrl: str(p.applyUrl) ?? `${p.hostedUrl.replace(/\/$/, '')}/apply`,
    };
    if ((p.workplaceType ?? '').toLowerCase() === 'remote') out.remote = true;
    return [out];
  });
}

interface AshbyJob {
  id?: string; title?: string; location?: string; secondaryLocations?: { location?: string }[]; isListed?: boolean; isRemote?: boolean | null;
  workplaceType?: string | null; address?: { postalAddress?: { addressCountry?: string } }; jobUrl?: string; applyUrl?: string;
}

export function parseAshbyBoard(data: unknown, slug: string): Posting[] {
  const jobs = (data as { jobs?: AshbyJob[] })?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((j) => {
    const title = str(j.title);
    const url = str(j.jobUrl);
    if (!title || !url || j.isListed === false) return [];
    const p: Posting = {
      kind: 'ashby', slug, postingId: j.id, title,
      location: join([join([j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)], ' / '), j.address?.postalAddress?.addressCountry]),
      url,
      applyUrl: str(j.applyUrl) ?? `${url.replace(/\/$/, '')}/application`,
    };
    if (j.workplaceType === 'Remote' || j.isRemote === true) p.remote = true;
    return [p];
  });
}

interface SrSummary { id?: string; name?: string; company?: { identifier?: string; name?: string }; location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string } }

export function parseSmartRecruitersList(data: unknown, slug: string): Posting[] {
  const content = (data as { content?: SrSummary[] })?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((s) => {
    const title = str(s.name);
    if (!title || !s.id) return [];
    const id = str(s.company?.identifier) ?? slug;
    const loc = s.location;
    const location = str(loc?.fullLocation)?.replace(/,\s*,/g, ',') ?? join([loc?.city, loc?.region, loc?.country ? COUNTRY_CODES[loc.country.toUpperCase()] ?? loc.country : undefined]);
    const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(id)}/${encodeURIComponent(s.id)}`;
    const p: Posting = { kind: 'smartrecruiters', slug: id, postingId: s.id, title, location, url, applyUrl: url };
    const company = str(s.company?.name);
    if (company) p.company = company;
    if (loc?.remote === true) p.remote = true;
    return [p];
  });
}

interface SrDetail extends SrSummary { postingUrl?: string; applyUrl?: string; active?: boolean }

/** GET /v1/companies/{id}/postings/{postingId} → Posting (closed when the API says inactive). */
export function parseSmartRecruitersDetail(data: unknown, slug: string): Posting | undefined {
  const d = data as SrDetail;
  const [base] = parseSmartRecruitersList({ content: [d] }, slug);
  if (!base) return undefined;
  if (str(d.postingUrl)) base.url = str(d.postingUrl)!;
  if (str(d.applyUrl)) base.applyUrl = str(d.applyUrl)!;
  if (d.active === false) base.closed = true;
  return base;
}

export async function fetchSmartRecruitersPosting(http: ResolverHttp, slug: string, postingId: string): Promise<Posting | undefined> {
  const res = await http.get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(postingId)}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return undefined;
  return parseSmartRecruitersDetail(jsonOf(res), slug);
}

interface WorkableJob {
  title?: string; shortcode?: string; url?: string; shortlink?: string; application_url?: string; telecommuting?: boolean;
  city?: string; state?: string; country?: string; locations?: { city?: string; region?: string; country?: string; hidden?: boolean }[];
}

export function parseWorkableWidget(data: unknown, slug: string): Posting[] {
  const d = data as { name?: string; jobs?: WorkableJob[] };
  if (!Array.isArray(d?.jobs)) return [];
  return d.jobs.flatMap((j) => {
    const title = str(j.title);
    const url = str(j.url) ?? str(j.shortlink) ?? (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : undefined);
    if (!title || !url || !j.shortcode) return [];
    const visible = (j.locations ?? []).filter((l) => !l.hidden);
    const location = visible.length ? join(visible.map((l) => join([l.city, l.region, l.country])), ' / ') : join([j.city, j.state, j.country]);
    const p: Posting = { kind: 'workable', slug, postingId: j.shortcode, title, location, url, applyUrl: str(j.application_url) ?? `${url.replace(/\/$/, '')}/apply` };
    const company = str(d.name);
    if (company) p.company = company;
    if (j.telecommuting === true) p.remote = true;
    return [p];
  });
}

const stripTags = (html: string) => cleanInline(decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')));

/** Teamtailor career site job list: <a href="https://{slug}.teamtailor.com/jobs/{id}-…">Title</a> + meta spans. */
export function parseTeamtailorJobs(html: string, slug: string): Posting[] {
  const out: Posting[] = [];
  const seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*\/jobs\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const company = /<meta\b[^>]*property="og:site_name"[^>]*content="([^"]*)"/i.exec(html)?.[1];
  anchors.forEach((m, i) => {
    const id = m[2];
    const title = stripTags(m[3]);
    if (!title || seen.has(id)) return;
    seen.add(id);
    const chunkEnd = anchors[i + 1]?.index ?? Math.min(html.length, (m.index ?? 0) + 3000);
    const meta = stripTags(html.slice((m.index ?? 0) + m[0].length, chunkEnd)).split(/\s*·\s*/).filter(Boolean).slice(0, 4).join(' · ');
    let url = decodeEntities(m[1]);
    if (url.startsWith('/')) url = `https://${slug}.teamtailor.com${url}`;
    const p: Posting = { kind: 'teamtailor', slug, postingId: id, title, location: meta, url, applyUrl: url };
    if (/\bremote\b/i.test(meta) && !/\bhybrid\b/i.test(meta)) p.remote = true;
    if (company && !/^teamtailor$/i.test(company)) p.company = cleanInline(decodeEntities(company));
    out.push(p);
  });
  return out;
}

function xmlTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return undefined;
  return cleanInline(decodeEntities(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ''))) || undefined;
}

/** Personio XML feed (/xml): <position><id/><name/><office/><additionalOffices/><subcompany/></position>. */
export function parsePersonioXml(xml: string, slug: string, host = `${slug}.jobs.personio.de`): Posting[] {
  if (!/<workzag-jobs\b/i.test(xml)) return [];
  return [...xml.matchAll(/<position\b[^>]*>([\s\S]*?)<\/position>/gi)].flatMap((m) => {
    const block = m[1].replace(/<jobDescriptions\b[\s\S]*?<\/jobDescriptions>/gi, '');
    const id = xmlTag(block, 'id');
    const title = xmlTag(block, 'name');
    if (!id || !title) return [];
    const offices = [xmlTag(block, 'office'), ...[...(/<additionalOffices\b[^>]*>([\s\S]*?)<\/additionalOffices>/i.exec(block)?.[1] ?? '').matchAll(/<office\b[^>]*>([\s\S]*?)<\/office>/gi)].map((o) => cleanInline(decodeEntities(o[1])))];
    const url = `https://${host}/job/${id}`;
    const p: Posting = { kind: 'personio', slug, postingId: id, title, location: join(offices, ' / '), url, applyUrl: url };
    const sub = xmlTag(block, 'subcompany')?.replace(/\s*-\s*\d+$/, '');
    if (sub) p.company = sub;
    if (offices.some((o) => /\bremote\b/i.test(o ?? ''))) p.remote = true;
    return [p];
  });
}

interface RecruiteeOffer { id?: number; title?: string; company_name?: string; careers_url?: string; careers_apply_url?: string; location?: string; city?: string; country?: string; remote?: boolean; status?: string }

export function parseRecruiteeOffers(data: unknown, slug: string): Posting[] {
  const offers = (data as { offers?: RecruiteeOffer[] })?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.flatMap((o) => {
    const title = str(o.title);
    const url = str(o.careers_url);
    if (!title || !url || (o.status && o.status !== 'published')) return [];
    const p: Posting = { kind: 'recruitee', slug, postingId: o.id !== undefined ? String(o.id) : undefined, title, location: str(o.location) ?? join([o.city, o.country]), url, applyUrl: str(o.careers_apply_url) ?? url };
    const company = str(o.company_name);
    if (company) p.company = company;
    if (o.remote === true) p.remote = true;
    return [p];
  });
}

interface BambooJob { id?: string | number; jobOpeningName?: string; location?: { city?: string | null; state?: string | null }; atsLocation?: { city?: string | null; state?: string | null; province?: string | null; country?: string | null }; isRemote?: boolean | null; locationType?: string }

export function parseBambooHrList(data: unknown, slug: string): Posting[] {
  const result = (data as { result?: BambooJob[] })?.result;
  if (!Array.isArray(result)) return [];
  return result.flatMap((j) => {
    const title = str(j.jobOpeningName);
    if (!title || j.id === undefined) return [];
    const url = `https://${slug}.bamboohr.com/careers/${j.id}`;
    const p: Posting = {
      kind: 'bamboohr', slug, postingId: String(j.id), title,
      location: join([j.atsLocation?.city ?? j.location?.city, j.atsLocation?.state ?? j.atsLocation?.province ?? j.location?.state, j.atsLocation?.country]),
      url, applyUrl: url,
    };
    if (j.isRemote === true || j.locationType === '1') p.remote = true;
    return [p];
  });
}

// ───────────────────────────── Probing ─────────────────────────────

export interface BoardResult { exists: boolean; postings: Posting[]; error?: string }

function endpoint(kind: ProbeKind, slug: string, title: string): string {
  const s = encodeURIComponent(slug);
  switch (kind) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`;
    case 'lever': return `https://api.lever.co/v0/postings/${s}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${s}`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100&q=${encodeURIComponent(cleanTitle(title))}`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${s}`;
    case 'teamtailor': return `https://${slug.toLowerCase()}.teamtailor.com/jobs`;
    case 'personio': return `https://${slug.toLowerCase()}.jobs.personio.de/xml`;
    case 'recruitee': return `https://${slug.toLowerCase()}.recruitee.com/api/offers`;
    case 'bamboohr': return `https://${slug.toLowerCase()}.bamboohr.com/careers/list`;
  }
}

/** Subdomain-based boards need a DNS-safe slug. */
function slugUsable(kind: ProbeKind, slug: string): boolean {
  if (['teamtailor', 'personio', 'recruitee', 'bamboohr'].includes(kind)) return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(slug);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug);
}

function parseBoard(kind: ProbeKind, res: FetchResult, slug: string): BoardResult {
  if (res.status === 404 || res.status === 410) return { exists: false, postings: [] };
  if (res.status !== 200) return { exists: false, postings: [], error: res.error ?? `HTTP ${res.status}` };
  switch (kind) {
    case 'greenhouse': {
      const data = jsonOf<unknown>(res);
      return data ? { exists: true, postings: parseGreenhouseJobs(data, slug) } : { exists: false, postings: [], error: 'bad JSON' };
    }
    case 'lever': {
      const data = jsonOf<unknown>(res);
      return Array.isArray(data) ? { exists: true, postings: parseLeverPostings(data, slug) } : { exists: false, postings: [] };
    }
    case 'ashby': {
      const data = jsonOf<unknown>(res);
      return data ? { exists: true, postings: parseAshbyBoard(data, slug) } : { exists: false, postings: [] };
    }
    case 'smartrecruiters': {
      const postings = parseSmartRecruitersList(jsonOf<unknown>(res), slug);
      return { exists: postings.length > 0, postings };
    }
    case 'workable': {
      const data = jsonOf<unknown>(res);
      return data ? { exists: true, postings: parseWorkableWidget(data, slug) } : { exists: false, postings: [] };
    }
    case 'teamtailor':
      if (!hostOf(res.url).endsWith('teamtailor.com') && !/teamtailor/i.test(res.text.slice(0, 50_000))) return { exists: false, postings: [] };
      return { exists: true, postings: parseTeamtailorJobs(res.text, slug) };
    case 'personio':
      return /<workzag-jobs\b/i.test(res.text) ? { exists: true, postings: parsePersonioXml(res.text, slug, hostOf(res.url) || undefined) } : { exists: false, postings: [] };
    case 'recruitee': {
      const data = jsonOf<unknown>(res);
      return data ? { exists: true, postings: parseRecruiteeOffers(data, slug) } : { exists: false, postings: [] };
    }
    case 'bamboohr': {
      // Unknown accounts redirect to www.bamboohr.com.
      const finalHost = hostOf(res.url);
      if (finalHost === 'www.bamboohr.com' || finalHost === 'bamboohr.com') return { exists: false, postings: [] };
      const data = jsonOf<unknown>(res);
      return data ? { exists: true, postings: parseBambooHrList(data, slug) } : { exists: false, postings: [] };
    }
  }
}

/** Probes boards by slug with a per-run cache (several jobs often share a company). */
export class BoardProber {
  private readonly cache = new Map<string, Promise<BoardResult>>();
  constructor(private readonly http: ResolverHttp) {}

  probe(kind: ProbeKind, slug: string, title = ''): Promise<BoardResult> {
    if (!slugUsable(kind, slug)) return Promise.resolve({ exists: false, postings: [] });
    const key = `${kind}:${slug.toLowerCase()}${kind === 'smartrecruiters' ? `:${cleanTitle(title).toLowerCase()}` : ''}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.fetchBoard(kind, slug, title);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private async fetchBoard(kind: ProbeKind, slug: string, title: string): Promise<BoardResult> {
    const url = endpoint(kind, slug, title);
    const headers = kind === 'teamtailor' || kind === 'personio' ? { Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' } : { Accept: 'application/json' };
    const res = await this.http.get(url, { headers });
    const parsed = parseBoard(kind, res, slug);
    if (kind === 'lever' && !parsed.exists && res.status === 404) {
      const eu = await this.http.get(url.replace('https://api.lever.co', 'https://api.eu.lever.co'), { headers });
      return parseBoard('lever', eu, slug);
    }
    return parsed;
  }
}
