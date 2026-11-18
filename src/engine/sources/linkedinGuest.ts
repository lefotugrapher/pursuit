// LinkedIn public, logged-out job pages only (SPEC §0.4): /jobs-guest/ search + jobPosting detail.
// No cookies, no login, ≤ 1 request / 3 s, and the first 429 / 999 / auth wall stops LinkedIn for the run.

import type { RawJob, SourceAdapter, SourceContext } from '@/lib/types';
import { type AdapterContext, passesPrefilter } from './common';
import { type PoliteGetOptions, errorMessage, errorStatus } from './http';
import { canonicalUrl, cleanInline, decodeEntities } from './normalize';

export const LINKEDIN_MIN_INTERVAL_MS = 3000;
/** Hard ceilings per run, whatever sources.json says, to stay a light, polite visitor. */
export const MAX_SEARCH_REQUESTS_PER_RUN = 100;
export const MAX_DETAIL_REQUESTS_PER_RUN = 60;

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

export interface LinkedInCard { id: string; title: string; company: string; location: string; url: string; postedAt?: string; salaryText?: string }
export interface LinkedInDetail {
  title?: string;
  company?: string;
  location?: string;
  descriptionHtml?: string;
  criteria: Record<string, string>;
  applyUrl?: string;
  salaryText?: string;
  closed: boolean;
}

export function searchUrl(keywords: string, location: string, start: number): string {
  const params = new URLSearchParams({ keywords, location, f_TPR: 'r604800', f_E: '1,2,3', start: String(start) });
  return `${SEARCH_URL}?${params.toString()}`;
}

export function detailUrl(id: string): string {
  return `${DETAIL_URL}/${encodeURIComponent(id)}`;
}

export function jobViewUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

// ───────────────────────────── HTML parsing (DOM-less) ─────────────────────────────

const stripTags = (html: string): string => cleanInline(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '));

/** Inner text of the first element whose class attribute contains `cls` (simple, non-nested elements). */
function textByClass(html: string, cls: string, tag = '[a-z0-9]+'): string | undefined {
  const re = new RegExp(`<(${tag})\\b[^>]*class="[^"]*\\b${cls.replace(/[-]/g, '\\-')}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1\\s*>`, 'i');
  const m = re.exec(html);
  const text = m ? stripTags(m[2]) : '';
  return text || undefined;
}

/** Inner HTML of the first <div> whose class contains `cls`, honouring nested <div>s. */
function innerDivByClass(html: string, cls: string): string | undefined {
  const open = new RegExp(`<div\\b[^>]*class="[^"]*\\b${cls.replace(/[-]/g, '\\-')}\\b[^"]*"[^>]*>`, 'i').exec(html);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 1;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index).trim();
  }
  return html.slice(start).trim();
}

/** Parses one page of guest search results (a fragment of <li> cards). */
export function parseSearchPage(html: string): LinkedInCard[] {
  const cards: LinkedInCard[] = [];
  const seen = new Set<string>();
  const marker = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  const hits = [...html.matchAll(marker)];
  hits.forEach((hit, i) => {
    const id = hit[1];
    if (seen.has(id)) return;
    const chunk = html.slice(hit.index ?? 0, hits[i + 1]?.index ?? html.length);
    const title = textByClass(chunk, 'base-search-card__title') ?? textByClass(chunk, 'sr-only');
    const company = textByClass(chunk, 'base-search-card__subtitle', 'h4');
    if (!title || !company) return;
    seen.add(id);
    const card: LinkedInCard = {
      id,
      title,
      company,
      location: textByClass(chunk, 'job-search-card__location') ?? '',
      url: jobViewUrl(id),
    };
    const posted = /<time\b[^>]*datetime="([^"]+)"/i.exec(chunk)?.[1];
    if (posted) card.postedAt = posted;
    const salary = textByClass(chunk, 'job-search-card__salary-info');
    if (salary) card.salaryText = salary;
    cards.push(card);
  });
  return cards;
}

/**
 * The external apply link LinkedIn embeds for "Apply on company website" jobs:
 * <code id="applyUrl"><!--"https://www.linkedin.com/jobs/view/externalApply/123?url=https%3A%2F%2F…"--></code>.
 * Returns the employer's URL (decoded url= param, tracking stripped) so the real ATS can be detected.
 */
export function extractExternalApplyUrl(html: string): string | undefined {
  const m = /<code\b[^>]*id="applyUrl"[^>]*>\s*<!--\s*"([\s\S]*?)"\s*-->\s*<\/code>/i.exec(html);
  if (!m) return undefined;
  const raw = decodeEntities(m[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/'));
  let target = raw;
  try {
    const u = new URL(raw);
    const inner = u.searchParams.get('url');
    if (inner) target = inner; // URLSearchParams already percent-decodes it
  } catch {
    return undefined;
  }
  try {
    const t = new URL(target);
    if (t.protocol !== 'https:' && t.protocol !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  return canonicalUrl(target);
}

/** Parses a guest jobPosting page. */
export function parseJobPosting(html: string): LinkedInDetail {
  const criteria: Record<string, string> = {};
  for (const item of html.matchAll(/<li\b[^>]*class="[^"]*description__job-criteria-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const label = textByClass(item[1], 'description__job-criteria-subheader', 'h3');
    const value = textByClass(item[1], 'description__job-criteria-text', 'span');
    if (label && value) criteria[label.toLowerCase()] = value;
  }
  const detail: LinkedInDetail = {
    title: textByClass(html, 'top-card-layout__title', 'h[12]'),
    company: textByClass(html, 'topcard__org-name-link', 'a') ?? textByClass(html, 'topcard__flavor', 'span'),
    location: textByClass(html, 'topcard__flavor--bullet', 'span'),
    descriptionHtml: innerDivByClass(html, 'show-more-less-html__markup') ?? innerDivByClass(html, 'description__text'),
    criteria,
    applyUrl: extractExternalApplyUrl(html),
    salaryText: textByClass(html, 'compensation__salary', 'div'),
    closed: /no longer accepting applications/i.test(stripTags(html.slice(0, 40_000))),
  };
  return detail;
}

// ───────────────────────────── Adapter ─────────────────────────────

/** A response that means "stop talking to LinkedIn for now". */
function isBlocked(status: number, finalUrl: string): boolean {
  return status === 429 || status === 999 || status === 403 || /\/(authwall|login|checkpoint|uas\/login)/i.test(finalUrl);
}

export function buildLinkedInJob(card: LinkedInCard, detail?: LinkedInDetail): RawJob {
  const applyUrl = detail?.applyUrl;
  const raw: RawJob = {
    source: 'linkedin_guest',
    sourceId: card.id,
    company: card.company,
    title: card.title,
    location: card.location || detail?.location || '',
    url: card.url,
    applyUrl: applyUrl ?? card.url,
    descriptionHtml: detail?.descriptionHtml,
    postedAt: card.postedAt,
    salaryText: detail?.salaryText ?? card.salaryText,
    employmentType: detail?.criteria['employment type'],
    department: detail?.criteria['job function'],
    atsMeta: {
      linkedinJobId: card.id,
      externalApply: Boolean(applyUrl),
      seniority: detail?.criteria['seniority level'],
      industries: detail?.criteria['industries'],
      detailFetched: Boolean(detail),
    },
  };
  return raw;
}

export const linkedinGuest: SourceAdapter = {
  id: 'linkedin_guest',
  label: 'LinkedIn (public job pages)',
  async fetch(ctx: SourceContext): Promise<RawJob[]> {
    const cfg = ctx.sources.linkedinGuest;
    if (!cfg.enabled || cfg.queries.length === 0) return [];
    const opts: PoliteGetOptions = { minIntervalMs: Math.max(LINKEDIN_MIN_INTERVAL_MS, cfg.minIntervalMs), retries: 0 };
    let stopped = false;
    let searchRequests = 0;

    const stop = (why: string) => {
      if (!stopped) ctx.log.warn(`linkedin: ${why}; backing off for the rest of this run`);
      stopped = true;
    };

    /** GET with the stop rules applied. undefined = no usable page. */
    const fetchPage = async (url: string): Promise<string | undefined> => {
      try {
        const res = await ctx.http.get(url, opts);
        if (isBlocked(res.status, res.url)) {
          stop(`HTTP ${res.status}${res.url !== url ? ` (redirected to ${new URL(res.url).pathname})` : ''}`);
          return undefined;
        }
        if (res.status < 200 || res.status >= 300) {
          ctx.log.warn(`linkedin: HTTP ${res.status} for ${new URL(url).pathname}`);
          return undefined;
        }
        return res.text;
      } catch (err) {
        if (errorStatus(err) === 429) stop('rate limited (429)');
        else ctx.log.warn('linkedin: request failed', { error: errorMessage(err) });
        return undefined;
      }
    };

    const cards = new Map<string, LinkedInCard>();
    queries: for (const q of cfg.queries) {
      for (let start = 0; start < cfg.maxPerQuery && !stopped; ) {
        if (searchRequests >= MAX_SEARCH_REQUESTS_PER_RUN) {
          ctx.log.info(`linkedin: search budget (${MAX_SEARCH_REQUESTS_PER_RUN} requests) used up for this run`);
          break queries;
        }
        searchRequests++;
        const html = await fetchPage(searchUrl(q.keywords, q.location, start));
        if (html === undefined) break;
        const page = parseSearchPage(html);
        if (page.length === 0) break;
        for (const card of page) {
          if (!cards.has(card.id) && passesPrefilter(ctx, card.title, card.location)) cards.set(card.id, card);
        }
        start += page.length;
      }
      if (stopped) break;
    }

    const known = (ctx as AdapterContext).haveDetail?.('linkedin_guest');
    const out: RawJob[] = [];
    let detailRequests = 0;
    for (const card of cards.values()) {
      let detail: LinkedInDetail | undefined;
      if (!stopped && !known?.has(card.id) && detailRequests < MAX_DETAIL_REQUESTS_PER_RUN) {
        detailRequests++;
        const html = await fetchPage(detailUrl(card.id));
        if (html) detail = parseJobPosting(html);
      }
      if (detail?.closed) continue;
      out.push(buildLinkedInJob(card, detail));
    }
    ctx.log.info(`linkedin: ${cards.size} matching cards from ${searchRequests} searches, ${detailRequests} detail pages${stopped ? ' (stopped early)' : ''}`);
    return out;
  },
};
